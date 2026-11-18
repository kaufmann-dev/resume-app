import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { testUtils } from 'better-auth/plugins';
import { createApp } from '../../server.js';
import { initAuth, mcpResource } from '../../oauth.js';
import { PostgresSessionStore } from '../../storage.js';
import { database } from './database.js';

export const ORIGIN = 'http://localhost:3001';
export const MCP_URL = mcpResource(ORIGIN);
export const REDIRECT_URI = 'http://127.0.0.1:9999/callback';

/** A stand-in Pocket ID that serves only what Better Auth reads at startup and at logout. */
async function startStubIssuer(t) {
  const issuer = express();
  const server = await new Promise(resolve => { const listening = issuer.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const issuerUrl = `http://127.0.0.1:${server.address().port}`;
  issuer.get('/.well-known/openid-configuration', (req, res) => res.json({
    issuer: issuerUrl,
    authorization_endpoint: `${issuerUrl}/authorize`,
    token_endpoint: `${issuerUrl}/api/oidc/token`,
    userinfo_endpoint: `${issuerUrl}/api/oidc/userinfo`,
    jwks_uri: `${issuerUrl}/.well-known/jwks.json`,
    end_session_endpoint: `${issuerUrl}/api/oidc/end-session`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256']
  }));
  return issuerUrl;
}

export function writeJson(directory, fileName, value) {
  fs.writeFileSync(path.join(directory, fileName), JSON.stringify(value), 'utf8');
}

/** Creates the app against a fresh schema; files written by `seed` are imported on first start. */
export async function createTestApp(t, { seed = () => {}, now } = {}) {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-resume-'));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  writeJson(dataDirectory, 'passcodes.json', []);
  seed(dataDirectory);
  const { storage } = await database(t, dataDirectory);
  const authConfig = {
    production: false,
    origin: ORIGIN,
    issuerUrl: await startStubIssuer(t),
    clientId: 'resume-test',
    clientSecret: 'resume-test-secret',
    sessionSecret: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    authSecret: 'test-auth-secret-that-is-longer-than-thirty-two-characters'
  };
  const auth = await initAuth(authConfig, storage.pool, { plugins: [testUtils()] });
  const sessionStore = new PostgresSessionStore(storage.pool);
  t.after(() => sessionStore.close());
  const app = createApp({ auth, authConfig, sessionStore, storage, staticDirectory: dataDirectory, ...(now ? { now } : {}) });
  return { app, auth, authConfig, storage, dataDirectory };
}

/** Signs a Pocket ID user in and returns the Cookie header of their admin session. */
export async function signInAdmin(auth, email = 'admin@example.com') {
  const { test } = await auth.$context;
  const user = await test.saveUser(test.createUser({ email, name: email.split('@')[0], emailVerified: true }));
  const { cookies, session } = await test.login({ userId: user.id });
  return { user, session, cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
}

export async function registerClient(app, overrides = {}) {
  const response = await request(app).post('/auth/oauth2/register').send({
    client_name: 'Test Client',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...overrides
  });
  if (response.status !== 200 && response.status !== 201) throw new Error(`Registration failed: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

/** Starts an authorization for the signed-in admin and returns the consent page URL it leads to. */
export async function startAuthorization(app, cookie, clientId, scope, { resource = MCP_URL } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope,
    state: 'test-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...(resource ? { resource } : {})
  });
  const response = await request(app).get(`/auth/oauth2/authorize?${query}`).set('Cookie', cookie);
  if (response.status !== 302) throw new Error(`Authorization failed: ${response.status} ${response.text}`);
  return { location: new URL(response.headers.location, ORIGIN), verifier };
}

export async function decideConsent(app, cookie, consentUrl, accept) {
  return request(app).post('/auth/oauth2/consent').set('Cookie', cookie).set('Origin', ORIGIN)
    .send({ accept, oauth_query: consentUrl.search.slice(1) });
}

export async function exchangeCode(app, clientId, code, verifier) {
  return request(app).post('/auth/oauth2/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: MCP_URL
  });
}

export async function refresh(app, clientId, refreshToken) {
  return request(app).post('/auth/oauth2/token').type('form').send({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: MCP_URL
  });
}

/** Runs the whole browser authorization for an MCP client and returns its tokens. */
export async function authorizeMcpClient(app, cookie, { scope = 'openid offline_access resume:read resume:write', client } = {}) {
  const registered = client ?? await registerClient(app);
  const { location, verifier } = await startAuthorization(app, cookie, registered.client_id, scope);
  if (location.pathname !== '/oauth/consent') throw new Error(`Expected the consent page, got ${location}`);
  const consent = await decideConsent(app, cookie, location, true);
  if (consent.status !== 200) throw new Error(`Consent failed: ${consent.status} ${JSON.stringify(consent.body)}`);
  const code = new URL(consent.body.url).searchParams.get('code');
  const token = await exchangeCode(app, registered.client_id, code, verifier);
  if (token.status !== 200) throw new Error(`Token exchange failed: ${token.status} ${JSON.stringify(token.body)}`);
  return { clientId: registered.client_id, ...token.body };
}

/** Parses a JSON-RPC response that the stateless endpoint may send as JSON or as one SSE message. */
export function rpcBody(response) {
  if (!response.headers['content-type']?.startsWith('text/event-stream')) return response.body;
  const data = response.text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
  return data ? JSON.parse(data) : undefined;
}

export function mcpRpc(app, token) {
  return async (method, params = {}, id = 1) => {
    const call = request(app).post('/mcp').set('Accept', 'application/json, text/event-stream');
    if (token) call.set('Authorization', `Bearer ${token}`);
    const response = await call.send({ jsonrpc: '2.0', id, method, params });
    response.rpc = rpcBody(response);
    return response;
  };
}
