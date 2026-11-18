import { createAuthClient } from 'better-auth/client';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { IDENTITY_SCOPES, MCP_SCOPES } from './oauth-scopes.js';

// oauthProviderClient carries the signed pending authorization through sign-in and consent.
const authClient = createAuthClient({ baseURL: `${window.location.origin}/auth`, plugins: [oauthProviderClient()] });
const card = document.getElementById('oauth-card');
const query = new URLSearchParams(window.location.search);
const SCOPE_DESCRIPTIONS = { ...IDENTITY_SCOPES, ...MCP_SCOPES };
const EXPIRED = 'This authorization request is incomplete or has expired. Start again from the app you are connecting.';

const theme = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('kaufmann_dev_theme='))?.split('=')[1];
document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'className') el.className = value;
    else el.setAttribute(key, value);
  });
  el.append(...children.flat().filter(child => child != null));
  return el;
}

const render = (...nodes) => card.replaceChildren(...nodes.filter(Boolean));
const errorBox = () => h('p', { className: 'oauth-error', role: 'alert' });

function showMessage(title, text) {
  render(h('h1', { className: 'oauth-title' }, title), h('p', { className: 'oauth-text' }, text));
}

function setPending(buttons, pending, active, label) {
  buttons.forEach(button => { button.disabled = pending; });
  if (active) active.textContent = pending ? label : active.dataset.label;
}

function renderSignIn() {
  const error = errorBox();
  if (query.has('error')) error.textContent = 'Sign-in failed. Try again.';
  const button = h('button', { type: 'button', 'data-label': 'Sign in with Pocket ID' }, 'Sign in with Pocket ID');
  button.addEventListener('click', async () => {
    setPending([button], true, button, 'Redirecting…');
    error.textContent = '';
    const result = await authClient.signIn.social({ provider: 'pocket-id', callbackURL: '/' });
    if (result.error) {
      error.textContent = result.error.message || 'Sign-in could not start. Try again.';
      setPending([button], false, button);
    }
  });
  render(
    h('h1', { className: 'oauth-title' }, 'Connect an app'),
    h('p', { className: 'oauth-text' }, 'Sign in to let an AI app access this résumé. You will review its access before anything is shared.'),
    button,
    error
  );
}

function hostOf(uri) {
  try { return new URL(uri).host; } catch { return null; }
}

async function renderConsent() {
  const clientId = query.get('client_id');
  if (!clientId || !query.has('sig')) return showMessage('Request expired', EXPIRED);
  const response = await fetch(`/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, { credentials: 'include' });
  if (response.status === 401) return showMessage('Session ended', 'Your sign-in has ended. Start again from the app you are connecting.');
  if (!response.ok) return showMessage('Unknown app', EXPIRED);
  const client = await response.json();
  const name = client.client_name || clientId;
  const returnHost = hostOf(query.get('redirect_uri') ?? '');
  const scopes = (query.get('scope') ?? '').split(' ').filter(Boolean);
  document.title = `Authorize ${name} · David Kaufmann`;

  const error = errorBox();
  const deny = h('button', { type: 'button', className: 'auth-admin-button', 'data-label': 'Deny' }, 'Deny');
  const allow = h('button', { type: 'button', 'data-label': 'Allow' }, 'Allow');
  const decide = async (accept, active) => {
    setPending([deny, allow], true, active, accept ? 'Allowing…' : 'Denying…');
    error.textContent = '';
    const result = await authClient.oauth2.consent({ accept });
    if (result.error || !result.data?.url) {
      error.textContent = result.error?.message || EXPIRED;
      setPending([deny, allow], false, active);
      return;
    }
    window.location.assign(result.data.url);
  };
  deny.addEventListener('click', () => decide(false, deny));
  allow.addEventListener('click', () => decide(true, allow));

  render(
    h('h1', { className: 'oauth-title' }, `Allow ${name} to access this résumé?`),
    client.client_uri ? h('p', { className: 'oauth-meta' }, client.client_uri) : null,
    returnHost ? h('p', { className: 'oauth-meta' }, `You will be returned to ${returnHost}.`) : null,
    h('p', { className: 'oauth-text' }, 'It will be able to:'),
    h('ul', { className: 'oauth-scopes' }, scopes.map(scope => h('li', {}, SCOPE_DESCRIPTIONS[scope] ?? scope))),
    error,
    h('div', { className: 'oauth-actions' }, deny, allow),
    h('p', { className: 'oauth-meta' }, 'You can revoke access at any time in the editor’s MCP tab.')
  );
}

if (window.location.pathname === '/oauth/consent') {
  renderConsent().catch(() => showMessage('Something went wrong', EXPIRED));
} else {
  renderSignIn();
}
