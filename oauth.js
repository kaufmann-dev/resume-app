import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { genericOAuth, jwt } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { withInferredApplicationType } from './oauth-registration.js';
import { OAUTH_SCOPES } from './oauth-scopes.js';

export const POCKET_ID_PROVIDER = 'pocket-id';
export const AUTH_BASE_PATH = '/auth';
export const ABSOLUTE_ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const IDLE_ADMIN_SESSION_SECONDS = 24 * 60 * 60;

/** The MCP endpoint's protected resource identifier (RFC 8707 / RFC 9728); tokens carry it as `aud`. */
export const mcpResource = origin => `${origin}/mcp`;

/**
 * Better Auth signs admins in through Pocket ID and is the OAuth 2.1 authorization server for MCP
 * clients: authorization code with PKCE, rotating refresh tokens, audience-bound JWT access tokens,
 * Client ID Metadata Documents, Dynamic Client Registration, and RFC 8414 / RFC 9728 discovery.
 */
export function createAuth(config, pool, { plugins = [] } = {}) {
  return betterAuth({
    baseURL: config.origin,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    database: pool,
    emailAndPassword: { enabled: false },
    trustedOrigins: config.production ? [config.origin] : [config.origin, 'http://localhost:*', 'http://127.0.0.1:*'],
    // Admin sessions slide with use up to a 24-hour idle limit; the server enforces the 7-day cap.
    session: { expiresIn: IDLE_ADMIN_SESSION_SECONDS, updateAge: 5 * 60 },
    advanced: { cookiePrefix: 'resume', ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
    // The OAuth provider issues tokens at /oauth2/token; the JWT plugin's session-token route is unused.
    disabledPaths: ['/token'],
    hooks: {
      before: createAuthMiddleware(async ctx => {
        if (ctx.path !== '/oauth2/register' || !ctx.body) return;
        return { context: { body: withInferredApplicationType(ctx.body) } };
      })
    },
    plugins: [
      genericOAuth({
        config: [{
          providerId: POCKET_ID_PROVIDER,
          name: 'Pocket ID',
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          discoveryUrl: new URL('.well-known/openid-configuration', config.issuerUrl.endsWith('/') ? config.issuerUrl : `${config.issuerUrl}/`).toString(),
          scopes: ['openid', 'email', 'profile']
        }]
      }),
      jwt(),
      mcp({
        loginPage: '/oauth/sign-in',
        consentPage: '/oauth/consent',
        resource: mcpResource(config.origin),
        scopes: OAUTH_SCOPES,
        clientRegistrationDefaultScopes: OAUTH_SCOPES,
        // Access tokens are stateless JWTs; a short lifetime bounds access after a revoke.
        accessTokenExpiresIn: 15 * 60,
        // Dynamic Client Registration for clients that predate Client ID Metadata Documents.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
      ...plugins
    ]
  });
}

/**
 * Creates the auth instance after the app's own migrations: Better Auth's tables are migrated under
 * an advisory lock so simultaneous replicas cannot race, then Pocket ID discovery must have worked,
 * otherwise startup fails instead of serving a login that can never succeed.
 */
export async function initAuth(config, pool, options) {
  const auth = createAuth(config, pool, options);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(732194602)');
    await (await getMigrations(auth.options)).runMigrations();
  } finally {
    await client.query('SELECT pg_advisory_unlock(732194602)').catch(() => {});
    client.release();
  }
  const context = await auth.$context;
  if (!context.socialProviders.some(provider => provider.id === POCKET_ID_PROVIDER)) {
    throw new Error('Pocket ID discovery failed; check OIDC_ISSUER_URL and that the provider is reachable');
  }
  return auth;
}
