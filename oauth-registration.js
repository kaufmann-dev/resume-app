const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isHttpLoopback(uri) {
  if (typeof uri !== 'string') return false;
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * MCP CLI clients (Claude Code, Codex, …) register `http://localhost:<port>/callback` redirects
 * without `application_type`, which Dynamic Client Registration defaults to `web`, and web clients
 * may not use loopback redirects. RFC 8252 §7.3 makes loopback redirects the native-app pattern, so
 * such registrations become `native`. Explicit values and any other redirect list are kept as sent.
 */
export function withInferredApplicationType(body) {
  if (!body || typeof body !== 'object' || body.application_type !== undefined) return body;
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isHttpLoopback)) return body;
  return { ...body, application_type: 'native' };
}
