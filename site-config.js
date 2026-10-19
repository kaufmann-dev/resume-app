export const SITE_ORIGIN = 'https://resume.kaufmann.dev';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeHostname(value = '') {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) return '';

  const firstValue = rawValue.split(',')[0].trim();

  try {
    return new URL(firstValue).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`http://${firstValue}`).hostname.toLowerCase();
    } catch {
      return firstValue.toLowerCase();
    }
  }
}

export function isLocalDevelopmentHostname(hostname = '') {
  return LOCAL_HOSTNAMES.has(normalizeHostname(hostname));
}
