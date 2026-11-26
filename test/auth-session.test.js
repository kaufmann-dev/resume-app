import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { ABSOLUTE_SESSION_MS, IDLE_SESSION_MS, loadAuthConfig } from '../auth.js';
import { initAuth } from '../oauth.js';
import { PASSCODE_RATE_LIMIT_MAX_FAILURES } from '../server.js';
import { database } from './helpers/database.js';
import {
  ORIGIN, authorizeMcpClient, createTestApp, mcpRpc, signInAdmin, writeJson
} from './helpers/oauth.js';

const TEST_SESSION_SECRET = 'test-session-secret-that-is-longer-than-thirty-two-characters';
const TEST_AUTH_SECRET = 'test-auth-secret-that-is-longer-than-thirty-two-characters';

async function createFixture(t) {
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  const fixture = await createTestApp(t, {
    now: () => currentTime,
    seed(directory) {
      writeJson(directory, 'passcodes.json', [
        { code: 'viewer-code', expires: '2099-12-31T23:59:59.999Z' },
        { code: 'expired-code', expires: '2000-01-01T00:00:00.000Z' }
      ]);
      writeJson(directory, 'document.json', { sections: [
        { id: 'compact', title: 'Compact', type: 'entries', items: [] },
        { id: 'extra', title: 'Extra', type: 'entries', items: [], visibility: 'full' }
      ] });
      fs.writeFileSync(path.join(directory, 'resume.pdf'), 'test pdf', 'utf8');
    }
  });
  return Object.defineProperty(fixture, 'now', {
    get() { return currentTime; },
    set(value) { currentTime = value; }
  });
}

/** Admin checks run on the real clock, which Better Auth uses for its own session expiry. */
async function createAdminFixture(t) {
  return createTestApp(t, {
    seed(directory) {
      writeJson(directory, 'passcodes.json', [{ code: 'viewer-code', expires: '2099-12-31T23:59:59.999Z' }]);
      writeJson(directory, 'document.json', { sections: [
        { id: 'compact', title: 'Compact', type: 'entries', items: [] },
        { id: 'extra', title: 'Extra', type: 'entries', items: [], visibility: 'full' }
      ] });
    }
  });
}

function sessionCookie(response) {
  return response.headers['set-cookie']?.find((cookie) => (
    cookie.startsWith('resume_session=')
  ));
}

test('viewer sessions use opaque cookies and enforce expiry and immediate revocation', async (t) => {
  const fixture = await createFixture(t);
  const viewer = request.agent(fixture.app);

  const expiredLogin = await viewer
    .post('/api/auth/passcode')
    .send({ passcode: 'expired-code' });
  assert.equal(expiredLogin.status, 403);

  const login = await viewer
    .post('/api/auth/passcode')
    .send({ passcode: 'viewer-code' });
  assert.equal(login.status, 200);
  assert.equal(login.body.isAdmin, false);

  const cookie = sessionCookie(login);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /viewer-code/);

  const restored = await viewer.get('/api/session');
  assert.equal(restored.status, 200);
  assert.equal(sessionCookie(restored), undefined);

  await fixture.storage.mutateCollection('passcodes', entries => { entries.length = 0; });
  const revoked = await viewer.get('/api/session');
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.error, 'Invalid passcode');
});

test('failed passcode attempts are proxy-safe rate limited without blocking valid codes', async (t) => {
  const fixture = await createFixture(t);
  const clientAddress = '198.51.100.20';

  for (let attempt = 0; attempt < PASSCODE_RATE_LIMIT_MAX_FAILURES; attempt += 1) {
    await request(fixture.app)
      .post('/api/auth/passcode')
      .set('X-Forwarded-For', `192.0.2.${attempt + 1}, ${clientAddress}`)
      .send({ passcode: `wrong-${attempt}` })
      .expect(401);
  }

  const limited = await request(fixture.app)
    .post('/api/auth/passcode')
    .set('X-Forwarded-For', `192.0.2.200, ${clientAddress}`)
    .send({ passcode: 'still-wrong' });

  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'Too many failed passcode attempts. Try again later.');
  assert.match(limited.headers['retry-after'], /^\d+$/);

  await request(fixture.app)
    .post('/api/auth/passcode')
    .set('X-Forwarded-For', `192.0.2.201, ${clientAddress}`)
    .send({ passcode: 'viewer-code' })
    .expect(200);

  await request(fixture.app)
    .post('/api/auth/passcode')
    .set('X-Forwarded-For', '198.51.100.21')
    .send({ passcode: 'wrong-from-another-client' })
    .expect(401);
});

test('passive restore does not extend idle time, while user actions do', async (t) => {
  const fixture = await createFixture(t);
  const viewer = request.agent(fixture.app);
  const createdAt = fixture.now;

  await viewer.post('/api/auth/passcode').send({ passcode: 'viewer-code' }).expect(200);
  fixture.now = createdAt + IDLE_SESSION_MS - 1;
  await viewer.get('/api/session').expect(200);
  fixture.now = createdAt + IDLE_SESSION_MS;
  await viewer.get('/api/session').expect(401);

  fixture.now = createdAt + IDLE_SESSION_MS + 1;
  const activeViewer = request.agent(fixture.app);
  await activeViewer.post('/api/auth/passcode').send({ passcode: 'viewer-code' }).expect(200);
  const secondCreatedAt = fixture.now;
  fixture.now = secondCreatedAt + IDLE_SESSION_MS - 1;
  await activeViewer.get('/api/download?lang=en').expect(200);
  fixture.now = secondCreatedAt + IDLE_SESSION_MS + 1;
  await activeViewer.get('/api/session').expect(200);
});

test('absolute lifetime ends active sessions at seven days', async (t) => {
  const fixture = await createFixture(t);
  const viewer = request.agent(fixture.app);
  const createdAt = fixture.now;

  await viewer.post('/api/auth/passcode').send({ passcode: 'viewer-code' }).expect(200);

  for (let elapsed = IDLE_SESSION_MS - 1; elapsed < ABSOLUTE_SESSION_MS; elapsed += IDLE_SESSION_MS - 1) {
    fixture.now = createdAt + elapsed;
    await viewer.get('/api/download?lang=en').expect(200);
  }

  fixture.now = createdAt + ABSOLUTE_SESSION_MS;
  await viewer.get('/api/session').expect(401);
});

test('viewer logout is local and does not call the provider', async (t) => {
  const fixture = await createFixture(t);
  const viewer = request.agent(fixture.app);

  await viewer.post('/api/auth/passcode').send({ passcode: 'viewer-code' }).expect(200);
  const logout = await viewer
    .post('/auth/logout')
    .query({ returnTo: 'https://resume.kaufmann.dev/' });

  assert.equal(logout.status, 303);
  assert.equal(logout.headers.location, 'https://resume.kaufmann.dev/');
  await viewer.get('/api/session').expect(401);
});

test('HTTPS production requests set a secure host-only cookie', async (t) => {
  const fixture = await createFixture(t);

  const login = await request(fixture.app)
    .post('/api/auth/passcode')
    .set('Host', 'resume.kaufmann.dev')
    .set('X-Forwarded-Proto', 'https')
    .send({ passcode: 'viewer-code' });
  const cookie = sessionCookie(login);

  assert.equal(login.status, 200);
  assert.doesNotMatch(cookie, /Domain=/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test('browser requests are limited to the production site and local development', async (t) => {
  const fixture = await createFixture(t);

  for (const origin of ['https://malicious.example', 'https://cv.kaufmann.dev']) {
    await request(fixture.app)
      .post('/api/auth/passcode')
      .set('Origin', origin)
      .send({ passcode: 'viewer-code' })
      .expect(403);
  }

  await request(fixture.app)
    .post('/api/auth/passcode')
    .set('Origin', 'https://resume.kaufmann.dev')
    .send({ passcode: 'viewer-code' })
    .expect(200)
    .expect('Access-Control-Allow-Origin', 'https://resume.kaufmann.dev');

  await request(fixture.app)
    .post('/api/auth/passcode')
    .set('Origin', 'http://localhost:5173')
    .send({ passcode: 'viewer-code' })
    .expect(200)
    .expect('Access-Control-Allow-Origin', 'http://localhost:5173');
});

test('admin sign-in starts Pocket ID with PKCE and the Better Auth callback', async (t) => {
  const { app, authConfig } = await createAdminFixture(t);
  const login = await request(app).get('/auth/login').query({ returnTo: 'http://localhost:5173/?view=full' });
  assert.equal(login.status, 303);
  const authorization = new URL(login.headers.location);
  assert.equal(`${authorization.origin}${authorization.pathname}`, `${authConfig.issuerUrl}/authorize`);
  assert.equal(authorization.searchParams.get('client_id'), 'resume-test');
  assert.equal(authorization.searchParams.get('redirect_uri'), `${ORIGIN}/auth/callback/pocket-id`);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('state'));
  assert.match(authorization.searchParams.get('scope'), /openid/);
});

test('admins manage passcodes and logout continues to the provider', async (t) => {
  const { app, auth, authConfig } = await createAdminFixture(t);
  const admin = await signInAdmin(auth);
  const { internalAdapter } = await auth.$context;
  await internalAdapter.createAccount({ userId: admin.user.id, providerId: 'pocket-id', accountId: 'pocket-subject', idToken: 'raw-id-token' });
  const as = call => call.set('Cookie', admin.cookie);

  const restored = await as(request(app).get('/api/session')).expect(200);
  assert.equal(restored.body.isAdmin, true);
  assert.deepEqual(restored.body.passcodesData, [{ code: 'viewer-code', expires: '2099-12-31T23:59:59.999Z' }]);
  const added = await as(request(app).post('/api/passcodes')).send({ code: 'managed-code', expires: '2099-01-01T00:00:00.000Z' }).expect(200);
  assert.equal(added.body.passcodes[1].code, 'MANAGED-CODE');
  const updated = await as(request(app).put('/api/passcodes/1')).send({ code: 'managed-code-updated', expires: '2099-02-01T00:00:00.000Z' }).expect(200);
  assert.equal(updated.body.passcodes[1].code, 'MANAGED-CODE-UPDATED');
  await as(request(app).delete('/api/passcodes/1')).expect(200);

  const logout = await as(request(app).post('/auth/logout'));
  assert.equal(logout.status, 303);
  const logoutUrl = new URL(logout.headers.location);
  assert.equal(`${logoutUrl.origin}${logoutUrl.pathname}`, `${authConfig.issuerUrl}/api/oidc/end-session`);
  assert.equal(logoutUrl.searchParams.get('id_token_hint'), 'raw-id-token');
  assert.equal(logoutUrl.searchParams.get('post_logout_redirect_uri'), `${ORIGIN}/`);
  await as(request(app).get('/api/session')).expect(401);
});

test('background checks do not extend the admin idle limit, user actions do', async (t) => {
  const { app, auth, storage } = await createAdminFixture(t);
  const admin = await signInAdmin(auth);
  const soon = new Date(Date.now() + 60 * 1000);
  const setExpiry = () => storage.pool.query('UPDATE session SET "expiresAt" = $1 WHERE id = $2', [soon, admin.session.id]);
  const expiry = async () => (await storage.pool.query('SELECT "expiresAt" FROM session WHERE id = $1', [admin.session.id])).rows[0].expiresAt.getTime();

  await setExpiry();
  await request(app).get('/api/session').set('Cookie', admin.cookie).expect(200);
  assert.equal(await expiry(), soon.getTime());

  await request(app).get('/api/data').set('Cookie', admin.cookie).expect(200);
  assert.ok(await expiry() > Date.now() + IDLE_SESSION_MS - 60 * 1000);
});

test('admin sessions end seven days after sign-in even while active', async (t) => {
  const { app, auth, storage } = await createAdminFixture(t);
  const admin = await signInAdmin(auth);
  await storage.pool.query('UPDATE session SET "createdAt" = $1 WHERE id = $2', [new Date(Date.now() - ABSOLUTE_SESSION_MS), admin.session.id]);
  const expired = await request(app).get('/api/data').set('Cookie', admin.cookie);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error, 'Session has expired');
  assert.equal((await storage.pool.query('SELECT 1 FROM session WHERE id = $1', [admin.session.id])).rowCount, 0);
});

test('startup fails when Pocket ID discovery is unreachable', async (t) => {
  const { storage } = await database(t, fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cv-resume-')));
  await assert.rejects(initAuth({
    production: false, origin: ORIGIN, issuerUrl: 'http://127.0.0.1:9', clientId: 'id', clientSecret: 'secret',
    sessionSecret: TEST_SESSION_SECRET, authSecret: TEST_AUTH_SECRET
  }, storage.pool), /Pocket ID discovery failed/);
});

const baseEnvironment = {
  ORIGIN: 'https://resume.kaufmann.dev',
  OIDC_ISSUER_URL: 'https://identity.example/',
  OIDC_CLIENT_ID: 'client-id',
  OIDC_CLIENT_SECRET: 'client-secret',
  SESSION_SECRET: TEST_SESSION_SECRET,
  BETTER_AUTH_SECRET: TEST_AUTH_SECRET
};

test('production auth configuration requires the canonical origin and strong secrets', () => {
  const environment = { ...baseEnvironment, NODE_ENV: 'production' };
  const config = loadAuthConfig(environment);
  assert.equal(config.origin, 'https://resume.kaufmann.dev');
  assert.equal(config.production, true);
  assert.throws(() => loadAuthConfig({ ...environment, ORIGIN: 'https://other.kaufmann.dev' }), /ORIGIN must be https:\/\/resume.kaufmann.dev/);
  assert.throws(() => loadAuthConfig({ ...environment, BETTER_AUTH_SECRET: 'short' }), /BETTER_AUTH_SECRET must be at least 32 characters/);
  assert.throws(() => loadAuthConfig({ ...environment, SESSION_SECRET: 'short' }), /SESSION_SECRET must be at least 32 characters/);
  const { BETTER_AUTH_SECRET, ...missing } = environment;
  assert.throws(() => loadAuthConfig(missing), /Missing required environment variable: BETTER_AUTH_SECRET/);
});

test('auth configuration accepts HTTP only for strict loopback URLs', () => {
  const loopback = loadAuthConfig({ ...baseEnvironment, ORIGIN: 'http://localhost:3001', OIDC_ISSUER_URL: 'http://127.0.0.2:8080/realms/admin' });
  assert.equal(loopback.origin, 'http://localhost:3001');
  assert.equal(loopback.issuerUrl, 'http://127.0.0.2:8080/realms/admin');
  for (const [name, value] of [['OIDC_ISSUER_URL', 'http://identity.example/'], ['ORIGIN', 'http://app.example']]) {
    assert.throws(() => loadAuthConfig({ ...baseEnvironment, [name]: value }), new RegExp(`${name} must use HTTPS unless it targets a loopback host`));
  }
});

test('auth configuration rejects ambiguous or overbroad URLs', () => {
  for (const [name, value, expectedError] of [
    ['OIDC_ISSUER_URL', 'https://user:secret@identity.example/', /must not include credentials/],
    ['OIDC_ISSUER_URL', 'https://@identity.example/', /must not include credentials/],
    ['OIDC_ISSUER_URL', 'https://identity.example/realms/admin?', /query or fragment/],
    ['ORIGIN', 'https://resume.kaufmann.dev/#', /query or fragment/],
    ['OIDC_ISSUER_URL', 'https://identity.example\\@malicious.example/', /backslashes/],
    ['ORIGIN', 'https://resume.kaufmann.dev/app', /origin-only/]
  ]) {
    assert.throws(() => loadAuthConfig({ ...baseEnvironment, [name]: value }), expectedError);
  }
});

test('OAuth endpoints accept any origin without credentials; other routes keep the allowlist', async (t) => {
  const { app } = await createAdminFixture(t);
  const registered = await request(app).post('/auth/oauth2/register').set('Origin', 'https://assistant.example')
    .send({ client_name: 'Web Client', redirect_uris: ['https://assistant.example/callback'], token_endpoint_auth_method: 'none' });
  assert.ok([200, 201].includes(registered.status), `${registered.status} ${registered.text}`);
  assert.equal(registered.headers['access-control-allow-origin'], '*');
  assert.equal(registered.headers['access-control-allow-credentials'], undefined);
  const discovery = await request(app).get('/.well-known/oauth-protected-resource/mcp').set('Origin', 'https://assistant.example').expect(200);
  assert.equal(discovery.headers['access-control-allow-origin'], '*');
  const challenge = await request(app).post('/mcp').set('Origin', 'https://assistant.example').send({});
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers['access-control-expose-headers'], /WWW-Authenticate/);
  await request(app).post('/auth/oauth2/consent').set('Origin', 'https://assistant.example').send({ accept: true }).expect(403);
  await request(app).post('/auth/sign-in/social').set('Origin', 'https://assistant.example').send({ provider: 'pocket-id' }).expect(403);
});

test('shared editor data and MCP writes require the correct credentials and revision', async t => {
  const fixture = await createAdminFixture(t);
  const viewer = request.agent(fixture.app);
  await viewer.post('/api/auth/passcode').send({ passcode: 'viewer-code' }).expect(200);
  await viewer.get('/api/data').expect(403);
  await viewer.get('/api/mcp').expect(403);
  await viewer.post('/api/save').send({}).expect(403);
  const admin = await signInAdmin(fixture.auth);
  const as = call => call.set('Cookie', admin.cookie);
  const tokens = await authorizeMcpClient(fixture.app, admin.cookie);
  const rpc = mcpRpc(fixture.app, tokens.access_token);
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.rpc.result.serverInfo.name, 'cv-resume');
  assert.equal((await rpc('tools/list')).rpc.result.tools.length, 10);
  const read = await rpc('tools/call', { name: 'get_document', arguments: {} });
  const document = JSON.parse(read.rpc.result.content[0].text);
  const updated = await rpc('tools/call', { name: 'replace_document', arguments: { data: { sections: [] }, revision: document.revision } });
  assert.ok(!updated.rpc.result.isError);
  await as(request(fixture.app).post('/api/save')).send(document).expect(409);
  const current = await as(request(fixture.app).get('/api/data')).expect(200);
  assert.deepEqual(current.body.data, { sections: [] });
  await as(request(fixture.app).post('/api/save')).send({ data: document.data, revision: current.body.revision }).expect(200);
  const preview = await rpc('tools/call', { name: 'preview_document', arguments: { view: 'compact' } });
  assert.deepEqual(JSON.parse(preview.rpc.result.content[0].text).sections.map(s => s.id), ['compact']);
  const viewerData = await viewer.get('/api/session').expect(200);
  assert.equal(viewerData.body.document, undefined);
  assert.deepEqual(viewerData.body.data.sections.map(s => [s.id, s.visibility]), [['compact', 'all'], ['extra', 'full']]);
  await as(request(fixture.app).post('/api/save')).send({ data: { sections: 'wrong' }, revision: document.revision }).expect(400);
  await as(request(fixture.app).delete(`/api/mcp/apps/${tokens.clientId}`)).set('Origin', ORIGIN).expect(200);
  const refreshed = await request(fixture.app).post('/auth/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId });
  assert.equal(refreshed.status, 400);
});
