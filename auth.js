import net from 'node:net';
import session from 'express-session';
import { SITE_ORIGIN } from './site-config.js';

export const IDLE_SESSION_MS = 24 * 60 * 60 * 1000;
export const ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function requireEnvironmentValue(environment, name) {
  const value = environment[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function isLoopbackHostname(hostname) {
  const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();

  if (normalizedHostname === 'localhost') {
    return true;
  }

  if (net.isIP(normalizedHostname) === 4) {
    return normalizedHostname.split('.')[0] === '127';
  }

  return normalizedHostname === '::1';
}

function parseUrl(value, name, { originOnly = false } = {}) {
  if (value.includes('\\')) {
    throw new Error(`${name} must not contain backslashes`);
  }

  if (value.includes('?') || value.includes('#')) {
    throw new Error(`${name} must not include a query or fragment`);
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }

  if (!value.toLowerCase().startsWith(`${parsedUrl.protocol}//`)) {
    throw new Error(`${name} must be an absolute URL`);
  }

  const authority = value.slice(value.indexOf('//') + 2).split('/')[0];

  if (authority.includes('@') || parsedUrl.username || parsedUrl.password) {
    throw new Error(`${name} must not include credentials`);
  }

  if (parsedUrl.protocol !== 'https:' && !isLoopbackHostname(parsedUrl.hostname)) {
    throw new Error(`${name} must use HTTPS unless it targets a loopback host`);
  }

  if (originOnly && parsedUrl.pathname !== '/') {
    throw new Error(`${name} must be an origin-only URL`);
  }

  return parsedUrl;
}

export function loadAuthConfig(environment = process.env) {
  const production = environment.NODE_ENV === 'production';
  const origin = parseUrl(requireEnvironmentValue(environment, 'ORIGIN'), 'ORIGIN', { originOnly: true }).origin;
  const issuerUrl = parseUrl(
    requireEnvironmentValue(environment, 'OIDC_ISSUER_URL'),
    'OIDC_ISSUER_URL'
  ).toString();
  const sessionSecret = requireEnvironmentValue(environment, 'SESSION_SECRET');
  const authSecret = requireEnvironmentValue(environment, 'BETTER_AUTH_SECRET');

  for (const [name, value] of [['SESSION_SECRET', sessionSecret], ['BETTER_AUTH_SECRET', authSecret]]) {
    if (value.length < 32) {
      throw new Error(`${name} must be at least 32 characters long`);
    }
  }

  if (production && origin !== SITE_ORIGIN) {
    throw new Error(`ORIGIN must be ${SITE_ORIGIN} in production`);
  }

  return {
    production,
    origin,
    issuerUrl,
    clientId: requireEnvironmentValue(environment, 'OIDC_CLIENT_ID'),
    clientSecret: requireEnvironmentValue(environment, 'OIDC_CLIENT_SECRET'),
    sessionSecret,
    authSecret
  };
}

export function createSessionMiddleware(config, store) {
  return session({
    name: 'resume_session',
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      httpOnly: true,
      maxAge: IDLE_SESSION_MS,
      sameSite: 'lax',
      secure: 'auto',
      path: '/'
    }
  });
}

export function regenerateSession(request) {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

export function saveSession(request) {
  return new Promise((resolve, reject) => {
    request.session.save((error) => error ? reject(error) : resolve());
  });
}

export function destroySession(request) {
  return new Promise((resolve, reject) => {
    request.session.destroy((error) => error ? reject(error) : resolve());
  });
}
