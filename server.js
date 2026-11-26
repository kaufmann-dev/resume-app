import { createPool, initializeStorage, PostgresSessionStore } from './storage.js';
import { createDocumentStore, publicationPdfName } from './document-store.js';
import { mountMcp } from './mcp.js';
import { listConnectedApps, revokeConnectedApp } from './connected-apps.js';
import { ABSOLUTE_ADMIN_SESSION_MS, POCKET_ID_PROVIDER, initAuth, mcpResource } from './oauth.js';
import { IDENTITY_SCOPES, MCP_SCOPES } from './oauth-scopes.js';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { renderErrorPage } from './error-page.js';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import {
  ABSOLUTE_SESSION_MS,
  IDLE_SESSION_MS,
  createSessionMiddleware,
  destroySession,
  loadAuthConfig,
  regenerateSession,
  saveSession
} from './auth.js';
import { SITE_ORIGIN, isLocalDevelopmentHostname } from './site-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESUME_PDF_LANGUAGES = ['en', 'de'];
const resumePdfName = lang => `resume-${lang}.pdf`;
const RESUME_PDF_DOWNLOAD_NAMES = { en: 'David_Kaufmann_Resume.pdf', de: 'David_Kaufmann_Lebenslauf.pdf' };
export const PASSCODE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const PASSCODE_RATE_LIMIT_MAX_FAILURES = 5;

function isAllowedBrowserOrigin(origin) {
  try {
    const candidate = new URL(origin);
    const normalizedOrigin = candidate.origin;

    if (normalizedOrigin === SITE_ORIGIN) {
      return true;
    }

    return (
      ['http:', 'https:'].includes(candidate.protocol)
      && isLocalDevelopmentHostname(candidate.hostname)
    );
  } catch {
    return false;
  }
}

// OAuth clients and MCP clients call these from any origin without cookies; the auth library and the
// token verifier protect them. Every other route keeps the credentialed same-origin allowlist.
const PUBLIC_OAUTH_PATHS = new Set(['/mcp', '/auth/oauth2/token', '/auth/oauth2/register', '/auth/oauth2/revoke']);
const isPublicOAuthPath = pathname => PUBLIC_OAUTH_PATHS.has(pathname) || pathname.startsWith('/.well-known/');
const MCP_SERVER_NAME = 'cv_resume';

function forwardSetCookies(headers, response) {
  for (const cookie of headers?.getSetCookie?.() ?? []) response.append('Set-Cookie', cookie);
}

const PDF_LIMIT_BYTES = 10 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PDF_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff'
};

function validateViewerPasscode(passcodes, passcode, now) {
  if (!passcode) {
    return { ok: false, status: 401, error: 'Not authenticated' };
  }

  const match = passcodes.find((entry) => entry.code === passcode);

  if (!match) {
    return { ok: false, status: 401, error: 'Invalid passcode' };
  }

  if (match.expires) {
    const expiresAt = new Date(match.expires);

    if (!Number.isNaN(expiresAt.getTime()) && now > expiresAt.getTime()) {
      return { ok: false, status: 403, error: 'Passcode has expired' };
    }
  }

  return { ok: true };
}

function getSafeReturnUrl(request, authConfig) {
  const requestedReturnUrl = typeof request.query.returnTo === 'string'
    ? request.query.returnTo
    : '';

  if (requestedReturnUrl) {
    try {
      const candidate = new URL(requestedReturnUrl);
      const knownProductionHostname = candidate.hostname.toLowerCase() === new URL(SITE_ORIGIN).hostname;
      const validProtocol = knownProductionHostname
        ? candidate.protocol === 'https:'
        : ['http:', 'https:'].includes(candidate.protocol);

      if (
        validProtocol
        && (knownProductionHostname || isLocalDevelopmentHostname(candidate.hostname))
      ) {
        candidate.hash = '';
        return candidate.toString();
      }
    } catch {
      // Fall through to a fixed configured origin.
    }
  }

  return `${authConfig.origin}/`;
}

function setAuthenticatedSession(request, auth, now) {
  request.session.auth = {
    ...auth,
    createdAt: now,
    lastActiveAt: now
  };
  request.session.cookie.maxAge = IDLE_SESSION_MS;
}

function markUserActivity(request, now) {
  const absoluteRemaining = request.session.auth.createdAt + ABSOLUTE_SESSION_MS - now;
  request.session.auth.lastActiveAt = now;
  request.session.cookie.maxAge = Math.min(IDLE_SESSION_MS, absoluteRemaining);
}

export function createApp({
  auth,
  authConfig,
  sessionStore,
  storage,
  staticDirectory = path.join(__dirname, 'dist'),
  now = () => Date.now()
}) {
  const app = express();
  const getPasscodes = () => storage.readCollection('passcodes');
  const store = createDocumentStore(storage.pool);
  const getViewerPasscodeAttempt = async (request) => {
    const passcode = typeof request.body?.passcode === 'string'
      ? request.body.passcode.trim()
      : '';

    return {
      passcode,
      validation: validateViewerPasscode(await getPasscodes(), passcode, now())
    };
  };

  const mcpUrl = mcpResource(authConfig.origin);
  const authHandler = toNodeHandler(auth);
  const publicCors = cors({ exposedHeaders: ['WWW-Authenticate'] });
  const browserCors = cors({
    origin(origin, callback) {
      callback(null, !origin || isAllowedBrowserOrigin(origin));
    },
    credentials: true
  });

  app.set('trust proxy', 1);
  app.use((request, response, next) => {
    if (isPublicOAuthPath(request.path)) return publicCors(request, response, next);
    const origin = request.headers.origin;

    if (origin && !isAllowedBrowserOrigin(origin)) {
      return response.status(403).json({ error: 'Request origin is not allowed' });
    }

    return browserCors(request, response, next);
  });
  app.use('/api', (request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  app.use(createSessionMiddleware(authConfig, sessionStore));

  app.get('/auth/login', async (request, response, next) => {
    try {
      const { headers, response: result } = await auth.api.signInSocial({
        body: { provider: POCKET_ID_PROVIDER, callbackURL: getSafeReturnUrl(request, authConfig) },
        headers: fromNodeHeaders(request.headers),
        returnHeaders: true
      });
      forwardSetCookies(headers, response);
      return response.redirect(303, result.url);
    } catch (error) {
      return next(error);
    }
  });

  // Ends viewer and admin sessions; admins continue to the identity provider's logout.
  app.post('/auth/logout', async (request, response, next) => {
    const localReturnUrl = getSafeReturnUrl(request, authConfig);

    try {
      if (request.session.auth) await destroySession(request);
      const headers = fromNodeHeaders(request.headers);
      const adminSession = await auth.api.getSession({ headers, query: { disableRefresh: true } });
      let providerLogoutUrl;

      if (adminSession) {
        const result = await auth.api.signOut({ headers, body: { callbackURL: `${authConfig.origin}/` }, returnHeaders: true });
        forwardSetCookies(result.headers, response);
        providerLogoutUrl = result.response?.url;
      }

      return response.redirect(303, providerLogoutUrl ?? localReturnUrl);
    } catch (error) {
      return next(error);
    }
  });

  // OAuth discovery (RFC 8414, RFC 9728, OpenID) lives at the origin root, outside /auth.
  app.get('/.well-known/*splat', authHandler);
  app.all('/auth/*splat', authHandler);
  mountMcp(app, { auth, store, resource: mcpUrl });
  for (const page of ['/oauth/sign-in', '/oauth/consent']) {
    app.get(page, (request, response) => {
      response.set('Cache-Control', 'no-store');
      response.sendFile(path.join(staticDirectory, 'oauth.html'));
    });
  }
  app.use(express.json({ limit: '2mb' }));

  const passcodeRateLimiter = rateLimit({
    windowMs: PASSCODE_RATE_LIMIT_WINDOW_MS,
    limit: PASSCODE_RATE_LIMIT_MAX_FAILURES,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many failed passcode attempts. Try again later.' },
    // Successful codes bypass the limiter, so shared-IP viewers retain access.
    // Failed attempts use the proxy-aware request.ip default key generator.
    async skip(request) {
      request.viewerPasscodeAttempt = await getViewerPasscodeAttempt(request);
      return request.viewerPasscodeAttempt.validation.ok;
    }
  });

  app.use('/api', async (request, response, next) => {
    try {
      // Background session checks must not extend the admin's idle limit.
      const result = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
        query: { disableRefresh: request.method === 'GET' && request.path === '/session' },
        returnHeaders: true
      });
      forwardSetCookies(result.headers, response);
      const adminSession = result.response;

      if (adminSession) {
        if (now() - new Date(adminSession.session.createdAt).getTime() < ABSOLUTE_ADMIN_SESSION_MS) {
          request.authContext = { kind: 'admin', userId: adminSession.user.id };
          return next();
        }

        await (await auth.$context).internalAdapter.deleteSession(adminSession.session.token);
        request.authFailure = { status: 401, error: 'Session has expired' };
        return next();
      }
    } catch (error) {
      return next(error);
    }

    const viewer = request.session.auth;

    if (!viewer) {
      return next();
    }

    const currentTime = now();
    const absoluteExpired = currentTime - viewer.createdAt >= ABSOLUTE_SESSION_MS;
    const idleExpired = currentTime - viewer.lastActiveAt >= IDLE_SESSION_MS;
    const validation = viewer.kind === 'viewer'
      ? validateViewerPasscode(await getPasscodes(), viewer.passcode, currentTime)
      : { ok: false, status: 401, error: 'Not authenticated' };

    if (absoluteExpired || idleExpired || !validation.ok) {
      request.authFailure = validation.ok
        ? { status: 401, error: 'Session has expired' }
        : validation;

      try {
        await destroySession(request);
      } catch (error) {
        return next(error);
      }

      return next();
    }

    request.authContext = viewer;
    return next();
  });

  function authenticationFailure(request, response) {
    const failure = request.authFailure ?? { status: 401, error: 'Not authenticated' };
    return response.status(failure.status).json({ error: failure.error });
  }

  function requireAuthenticated(request, response, { userDriven = true } = {}) {
    if (!request.authContext) {
      authenticationFailure(request, response);
      return false;
    }

    if (userDriven && request.authContext.kind === 'viewer') {
      markUserActivity(request, now());
    }

    return true;
  }

  function requireAdmin(request, response) {
    if (!requireAuthenticated(request, response)) {
      return false;
    }

    if (request.authContext.kind !== 'admin') {
      response.status(403).json({ error: 'Admin access required' });
      return false;
    }

    return true;
  }

  // Uploaded résumé PDFs in the order of RESUME_PDF_LANGUAGES, without their bytes.
  async function listResumePdfs() {
    const rows = await storage.readPdfMetadata(RESUME_PDF_LANGUAGES.map(resumePdfName));
    return RESUME_PDF_LANGUAGES.flatMap(lang => {
      const row = rows.find(entry => entry.name === resumePdfName(lang));
      return row ? [{ lang, size: row.size, updatedAt: row.updatedAt }] : [];
    });
  }

  async function buildSessionResponse(request) {
    const document = await store.read();
    const response = {
      success: true,
      data: document.data,
      pdfLanguages: (await listResumePdfs()).map(pdf => pdf.lang),
      isAdmin: request.authContext.kind === 'admin'
    };

    if (response.isAdmin) {
      response.document = document;
      response.passcodesData = await getPasscodes();
    }

    return response;
  }

  app.post('/api/auth/passcode', passcodeRateLimiter, async (request, response, next) => {
    const { passcode, validation } = request.viewerPasscodeAttempt
      ?? await getViewerPasscodeAttempt(request);

    if (!validation.ok) {
      return response.status(validation.status).json({ error: validation.error });
    }

    try {
      await regenerateSession(request);
      setAuthenticatedSession(request, { kind: 'viewer', passcode }, now());
      await saveSession(request);
      request.authContext = request.session.auth;
      return response.json(await buildSessionResponse(request));
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/session', async (request, response) => {
    if (!requireAuthenticated(request, response, { userDriven: false })) {
      return;
    }

    response.json(await buildSessionResponse(request));
  });

  app.get('/api/download', async (request, response) => {
    if (!requireAuthenticated(request, response)) {
      return;
    }

    const { lang } = request.query;

    if (!RESUME_PDF_LANGUAGES.includes(lang)) {
      return response.status(400).send('Unknown PDF language');
    }

    const pdf = await storage.readPdf(resumePdfName(lang));

    if (!pdf) {
      return response.status(404).send('PDF not found');
    }

    response.set(PDF_RESPONSE_HEADERS);

    return response.attachment(RESUME_PDF_DOWNLOAD_NAMES[lang]).type('application/pdf').send(pdf.bytes);
  });

  app.get('/api/pdf', async (request, response) => {
    if (!requireAdmin(request, response)) return;
    const pdfs = await listResumePdfs();
    return response.json({
      files: RESUME_PDF_LANGUAGES.map(lang => {
        const pdf = pdfs.find(entry => entry.lang === lang);
        return pdf ? { lang, exists: true, size: pdf.size, updatedAt: pdf.updatedAt.toISOString() } : { lang, exists: false };
      })
    });
  });

  const requireResumePdfLanguage = (request, response, next) => RESUME_PDF_LANGUAGES.includes(request.params.lang)
    ? next()
    : response.status(400).json({ error: 'Unknown PDF language' });

  const adminOnly = (request, response, next) => { if (requireAdmin(request, response)) next(); };
  const pdfUpload = [
    adminOnly,
    express.raw({ type: 'application/pdf', limit: PDF_LIMIT_BYTES }),
    (request, response, next) => {
      if (!Buffer.isBuffer(request.body) || !request.body.length) {
        return response.status(400).json({ error: 'Upload a PDF file with Content-Type: application/pdf' });
      }
      if (request.body.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return response.status(400).json({ error: 'Uploaded file is not a valid PDF' });
      }
      return next();
    }
  ];

  app.post('/api/pdf/:lang', ...pdfUpload, requireResumePdfLanguage, async (request, response) => {
    const { lang } = request.params;
    const metadata = await storage.writePdf(resumePdfName(lang), request.body);
    return response.json({ success: true, lang, ...metadata });
  });

  app.delete('/api/pdf/:lang', adminOnly, requireResumePdfLanguage, async (request, response) => {
    if (!await storage.deletePdf(resumePdfName(request.params.lang))) return response.status(404).json({ error: 'PDF not found' });
    return response.json({ success: true });
  });

  // Uploads stay unreferenced until the editor saves the returned id into a publication.
  app.post('/api/publication-pdf', ...pdfUpload, async (request, response) => {
    const id = randomUUID();
    const metadata = await storage.writePdf(publicationPdfName(id), request.body);
    return response.json({ success: true, id, ...metadata });
  });

  app.get('/api/publication-pdf/:id', async (request, response) => {
    if (!requireAuthenticated(request, response)) return;
    const { id } = request.params;
    const pdf = UUID_PATTERN.test(id) ? await storage.readPdf(publicationPdfName(id)) : undefined;
    if (!pdf) return response.status(404).json({ error: 'PDF not found' });
    const publication = (await store.read()).data.sections
      .flatMap(section => section.type === 'pub' ? section.items : [])
      .find(item => item.pdf === id);
    const title = publication?.title;
    const name = (typeof title === 'string' ? title : title?.en ?? title?.de ?? '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'publication';
    response.set({ ...PDF_RESPONSE_HEADERS, 'Content-Disposition': `inline; filename="${name}.pdf"` });
    return response.type('application/pdf').send(pdf.bytes);
  });

  app.get('/api/data', async (request, response) => {
    if (requireAdmin(request, response)) response.json(await store.read());
  });

  app.post('/api/save', async (request, response) => {
    if (!requireAdmin(request, response)) return;
    try {
      response.json({ success: true, ...await store.write(request.body.data, request.body.revision) });
    } catch (error) {
      response.status(error.status || (error.name === 'ZodError' ? 400 : 500)).json({ error: error.message });
    }
  });

  app.get('/api/mcp', async (request, response) => {
    if (!requireAdmin(request, response)) return;
    response.json({ url: mcpUrl, serverName: MCP_SERVER_NAME, scopes: { ...IDENTITY_SCOPES, ...MCP_SCOPES }, apps: await listConnectedApps(storage.pool, request.authContext.userId) });
  });

  app.delete('/api/mcp/apps/:clientId', async (request, response) => {
    if (!requireAdmin(request, response)) return;
    await revokeConnectedApp(storage.pool, request.authContext.userId, request.params.clientId);
    response.json({ apps: await listConnectedApps(storage.pool, request.authContext.userId) });
  });

  app.get('/api/passcodes', async (request, response) => {
    if (!requireAdmin(request, response)) return;
    return response.json({ passcodes: await getPasscodes() });
  });

  app.post('/api/passcodes', async (request, response) => {
    if (!requireAdmin(request, response)) return;

    const { code, expires } = request.body;

    if (!code || !expires) {
      return response.status(400).json({ error: 'Missing code or expires' });
    }

    const passcodes = await storage.mutateCollection('passcodes', entries => { entries.push({ code, expires }); });
    return response.json({ success: true, passcodes });
  });

  for (const method of ['put', 'delete']) {
    app[method]('/api/passcodes/:index', async (request, response) => {
      if (!requireAdmin(request, response)) return;
      const index = Number(request.params.index);
      const { code, expires } = request.body ?? {};
      if (method === 'put' && (!code || !expires)) return response.status(400).json({ error: 'Missing code or expires' });
      const passcodes = await storage.mutateCollection('passcodes', entries => {
        if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
          const error = new Error('Invalid index');
          error.status = 400;
          throw error;
        }
        if (method === 'put') entries[index] = { code, expires };
        else entries.splice(index, 1);
      });
      response.json({ success: true, passcodes });
    });
  }

  app.use(express.static(staticDirectory));

  // Browser navigations get an HTML error page; API and MCP clients keep JSON errors.
  function sendError(request, response, status, error) {
    if (request.accepts(['json', 'html']) === 'html') {
      const language = request.acceptsLanguages('en', 'de') || 'en';
      return response.status(status).type('html').send(renderErrorPage(status, language));
    }
    return response.status(status).json({ error });
  }

  app.use((request, response) => sendError(request, response, 404, 'Not found'));

  app.use((error, request, response, next) => {
    if (error?.type === 'entity.too.large') return response.status(413).json({ error: 'PDF exceeds the 10 MB limit' });
    return next(error);
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    console.error('Request failed:', error.message);
    const status = error.status || 500;
    return sendError(request, response, status, error.status ? error.message : 'Request failed');
  });

  return app;
}

export async function startServer() {
  const authConfig = loadAuthConfig();
  const pool = createPool();
  let sessionStore;
  try {
    const storage = await initializeStorage({ pool, baseDirectory: __dirname });
    const auth = await initAuth(authConfig, pool);
    sessionStore = new PostgresSessionStore(pool);
    const app = createApp({ auth, authConfig, sessionStore, storage });
    const port = Number(process.env.PORT) || 3001;
    const server = app.listen(port, () => console.log(`Server running on port ${port}`));
    const shutdown = () => {
      sessionStore.close();
      server.close(() => { void pool.end(); });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    return server;
  } catch (error) {
    sessionStore?.close();
    await pool.end();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer().catch((error) => {
    console.error('Failed to start server:', error.message);
    process.exitCode = 1;
  });
}
