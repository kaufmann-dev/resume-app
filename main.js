import { projectDocument } from './document-model.js';
import { createIcons, Download, Languages, ListMinus, ListPlus, LogOut, Menu, Moon, SquarePen, Sun } from 'lucide';
import { isLocalDevelopmentHostname } from './site-config.js';

const DEFAULT_LANG = 'en';
const DEFAULT_THEME = 'light';
const PREF_COOKIE_MAX_AGE = 31536000;


let lang = DEFAULT_LANG;
let theme = DEFAULT_THEME;
let sourceDocument = null;
let view = new URLSearchParams(window.location.search).get('view') === 'full' ? 'full' : 'compact';

const API_BASE_URL = isLocalDevelopmentHostname(window.location.hostname)
  ? 'http://localhost:3001'
  : '';

const authContainer = document.getElementById('auth-container');
const contentContainer = document.getElementById('cv-container');
const authError = document.getElementById('auth-error');
const passcodeInput = document.getElementById('passcode-input');
const adminLoginButton = document.getElementById('admin-login-btn');
const authTitle = document.getElementById('auth-title');
const authDividerLabel = document.getElementById('auth-divider-label');
const downloadButton = document.getElementById('btn-dl');
const logoutButton = document.getElementById('btn-logout');
const editButton = document.getElementById('btn-edit');

const sectionNav = document.getElementById('section-nav');
const toolbarWrap = document.getElementById('toolbar-wrap');
const menuButton = document.getElementById('btn-menu');

function buildApiUrl(path) {
  return new URL(path, API_BASE_URL || window.location.origin);
}

function getSharedPreferenceCookieDomain() {
  const hostname = window.location.hostname.toLowerCase();

  if (hostname === 'kaufmann.dev' || hostname.endsWith('.kaufmann.dev')) {
    return '.kaufmann.dev';
  }

  return '';
}

function getCookieValue(name) {
  const encodedName = `${name}=`;
  const cookiePart = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(encodedName));

  if (!cookiePart) {
    return '';
  }

  return decodeURIComponent(cookiePart.slice(encodedName.length));
}

function setCookieValue(name, value, options = {}) {
  const {
    maxAge = PREF_COOKIE_MAX_AGE,
    domain = getSharedPreferenceCookieDomain()
  } = options;

  const securePart = window.location.protocol === 'https:' ? '; Secure' : '';
  const domainPart = domain ? `; Domain=${domain}` : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${domainPart}${securePart}`;
}

function getStoredTheme() {
  const storedTheme = getCookieValue('kaufmann_dev_theme');
  return storedTheme === 'dark' ? 'dark' : DEFAULT_THEME;
}

function getStoredLanguage() {
  const storedLanguage = getCookieValue('kaufmann_dev_lang');
  return storedLanguage === 'de' ? 'de' : DEFAULT_LANG;
}

function persistTheme() {
  setCookieValue('kaufmann_dev_theme', theme);
}

function persistLanguage() {
  setCookieValue('kaufmann_dev_lang', lang);
}

function localize(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value;
  return value[lang] ?? value.en ?? value.de ?? '';
}


function applyLegalFooter() {
  const imprintLink = document.getElementById('link-imprint');
  const privacyLink = document.getElementById('link-privacy');

  if (imprintLink) {
    imprintLink.textContent = localize({ en: 'Imprint', de: 'Impressum' });
  }
  if (privacyLink) {
    privacyLink.textContent = localize({ en: 'Privacy', de: 'Datenschutz' });
  }
}

// Every action shows its label as visible text, in the menu and in the wide-screen sidebar.
function setButtonLabel(button, label) {
  button.querySelector('.tbtn-label').textContent = localize(label);
}

function applyChrome() {
  document.documentElement.lang = lang;
  document.title = localize({ en: 'David Kaufmann - Resume', de: 'David Kaufmann - Lebenslauf' });
  document.getElementById('login-btn').textContent = localize({ en: 'View Resume', de: 'Lebenslauf ansehen' });
  authTitle.textContent = localize({ en: 'Private Access', de: 'Privater Zugang' });
  passcodeInput.placeholder = localize({ en: 'Enter Passcode...', de: 'Passcode eingeben...' });
  passcodeInput.setAttribute('aria-label', localize({ en: 'Passcode', de: 'Passcode' }));
  authDividerLabel.textContent = localize({ en: 'or', de: 'oder' });
  adminLoginButton.textContent = localize({ en: 'Admin sign in', de: 'Admin-Zugang' });
  document.getElementById('menu-label').textContent = localize({ en: 'Menu', de: 'Menü' });
  for (const [id, label] of Object.entries({
    'btn-edit': { en: 'Edit content', de: 'Inhalt bearbeiten' },
    'btn-dl': { en: 'Download PDF', de: 'PDF herunterladen' },
    'btn-lang': { en: 'Switch to German', de: 'Zu Englisch wechseln' },
    'btn-logout': { en: 'Sign out', de: 'Abmelden' },
  })) {
    setButtonLabel(document.getElementById(id), label);
  }
  applyThemeIcons();
  applyViewIcons();
  applyLegalFooter();
}

function mkEntry(item) {
  const heading = localize(item.heading);
  const subheading = localize(item.subheading);
  const info = localize(item.info);
  const subinfo = localize(item.subinfo);
  const highlights = (item.highlights || []).map(localize);
  const hasHeading = Boolean(heading);
  const hasSubheading = Boolean(subheading);
  const hasInfo = Boolean(info);
  const hasSubinfo = Boolean(subinfo);

  const mobileMetaParts = [];

  if (hasInfo) {
    mobileMetaParts.push(`<span class="entry-location">${info}</span>`);
  }

  if (hasInfo && hasSubinfo) {
    mobileMetaParts.push('<span class="entry-meta-sep">&#183;</span>');
  }

  if (hasSubinfo) {
    mobileMetaParts.push(`<span class="entry-date">${subinfo}</span>`);
  }

  const mobMeta = mobileMetaParts.join('');
  const useInlineMeta = hasHeading && !hasSubheading && (hasInfo || hasSubinfo);
  const topRightMeta = hasInfo ? `<span class="entry-location">${info}</span>` : '';
  const inlineMeta = useInlineMeta ? `
      <span class="entry-inline-meta entry-inline-meta--text">
        ${hasInfo ? `<span class="entry-location">${info}</span>` : ''}
        ${(hasInfo && hasSubinfo) ? '<span class="entry-meta-sep">&#183;</span>' : ''}
        ${hasSubinfo ? `<span class="entry-date">${subinfo}</span>` : ''}
      </span>
    ` : '';
  const bottomRightMeta = !useInlineMeta && hasSubinfo ? `<span class="entry-date">${subinfo}</span>` : '';
  const showSecondRow = hasSubheading || Boolean(bottomRightMeta);

  return `<div class="entry">
    ${mobMeta ? `<div class="e-mob">${mobMeta}</div>` : ''}
    <div class="e-r1"><span class="entry-title">${heading}</span>${useInlineMeta ? inlineMeta : topRightMeta}</div>
    ${showSecondRow ? `<div class="e-r2">${hasSubheading ? `<span class="entry-subtitle">${subheading}</span>` : ''}${bottomRightMeta}</div>` : ''}
    ${highlights.length ? `<ul>${highlights.map((highlight) => `<li>${highlight}</li>`).join('')}</ul>` : ''}
    ${item.tags?.length ? `<div class="tags">${item.tags.map((tag) => `<span class="tag">${localize(tag)}</span>`).join('')}</div>` : ''}
  </div>`;
}

function sectionAnchor(section) {
  return `section-${section.id}`;
}

function mkSection(section) {
  let body = '';

  if (section.type === 'info') {
    body = `<div class="info-grid">${section.rows.map((row) => `<div class="il">${localize(row.label)}</div><div class="iv">${localize(row.value)}</div>`).join('')}</div>`;
  } else if (section.type === 'entries') {
    const items = section.items || [];
    body = items.map(mkEntry).join('');
  } else if (section.type === 'pub') {
    if (section.items) {
      body = section.items.map(pub => {
        const authors = (pub.authors || []).filter(a => a.name).map(a => a.bold ? `<strong>${a.name}</strong>` : a.name).join(' &amp; ');
        const title = localize(pub.title);
        const institution = localize(pub.institution);
        return `<div class="pub">${authors}${pub.year ? ` (${pub.year})` : ''}${authors || pub.year ? '. ' : ''}${title ? `<em>${title}</em>` : ''}${institution ? ` ${institution}.` : ''}</div>`;
      }).join('');

    }
  }

  return `<section class="sec" id="${sectionAnchor(section)}"><h2>${localize(section.title)}</h2><div class="sec-body">${body}</div></section>`;
}

function renderSectionNav(sections) {
  sectionNav.innerHTML = `<ul>${sections.map((section) => `<li><a href="#${sectionAnchor(section)}">${localize(section.title)}</a></li>`).join('')}</ul>`;
  sectionNav.setAttribute('aria-label', localize({ en: 'Sections', de: 'Abschnitte' }));
  highlightCurrentSection();
}

// The current section is the last one whose heading has scrolled past the top; at the page end,
// short final sections can never get there, so the last one wins.
function highlightCurrentSection() {
  const sections = [...document.querySelectorAll('#cv-body .sec')];
  const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  const current = atEnd
    ? sections.at(-1)
    : sections.filter((section) => section.getBoundingClientRect().top <= 80).at(-1) ?? sections[0];
  sectionNav.querySelectorAll('a').forEach((link) => {
    link.toggleAttribute('aria-current', link.hash === `#${current?.id}`);
  });
}

function applyThemeIcons() {
  const darkMode = theme === 'dark';
  setButtonLabel(document.getElementById('btn-theme'), darkMode
    ? { en: 'Use light theme', de: 'Helles Design verwenden' }
    : { en: 'Use dark theme', de: 'Dunkles Design verwenden' });
  const sun = document.getElementById('ico-sun');
  const moon = document.getElementById('ico-moon');

  if (sun) sun.style.display = darkMode ? '' : 'none';
  if (moon) moon.style.display = darkMode ? 'none' : '';
}

function applyViewIcons() {
  const fullView = view === 'full';
  const button = document.getElementById('btn-view');
  setButtonLabel(button, fullView
    ? { en: 'Show compact version', de: 'Kompakte Version anzeigen' }
    : { en: 'Show full version', de: 'Vollständige Version anzeigen' });
  button.setAttribute('aria-pressed', String(fullView));
  document.getElementById('ico-expand').style.display = fullView ? 'none' : '';
  document.getElementById('ico-collapse').style.display = fullView ? '' : 'none';
}

function render() {
  if (!sourceDocument) return;

  document.documentElement.lang = lang;

  const { sections } = projectDocument(sourceDocument, view);
  document.getElementById('cv-body').innerHTML = sections.map(mkSection).join('');
  renderSectionNav(sections);
  applyChrome();
}

function showAuthenticatedView() {
  document.body.classList.remove('is-auth-view');
  authContainer.style.display = 'none';
  contentContainer.style.display = 'block';
  logoutButton.style.display = '';
}

function showAuthView(message = '') {
  document.body.classList.add('is-auth-view');
  contentContainer.style.display = 'none';
  authContainer.style.display = 'flex';
  authError.textContent = message;
  logoutButton.style.display = 'none';
  editButton.style.display = 'none';
  sourceDocument = null;
}

async function authenticate(options = {}) {
  const {
    passcode = '',
    suppressErrors = false
  } = options;

  authError.textContent = '';

  try {
    const endpoint = passcode ? '/api/auth/passcode' : '/api/session';
    const requestOptions = {
      method: passcode ? 'POST' : 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    };

    if (passcode) {
      requestOptions.body = JSON.stringify({ passcode });
    }

    const response = await fetch(buildApiUrl(endpoint), requestOptions);

    const result = await response.json();

    if (!response.ok || !result.success) {
      if (!suppressErrors) {
        showAuthView(result.error || 'Login failed');
      }

      return false;
    }

    sourceDocument = result.data;
    showAuthenticatedView();
    render();

    if (result.isAdmin) {
      try {
        const { initEditor } = await import('./editor.js');
        initEditor({
          document: result.document,
          passcodesData: result.passcodesData,
          apiBaseUrl: API_BASE_URL,
          onSave: (data) => {
            sourceDocument = data;
            render();
          }
        });

        editButton.style.display = '';
      } catch (e) {
        console.error('Failed to load editor:', e);
      }
    }

    return true;
  } catch (error) {
    if (!suppressErrors) {
      showAuthView('Server error. Is the backend running?');
    }

    return false;
  }
}

async function handleLogin() {
  const passcode = passcodeInput.value.trim();

  if (!passcode) {
    authError.textContent = localize({
      en: 'Please enter a passcode',
      de: 'Bitte Passcode eingeben'
    });
    return;
  }

  const success = await authenticate({ passcode });

  if (success) {
    passcodeInput.value = '';
  }
}

function handleDownload() {
  if (!sourceDocument) {
    showAuthView(localize({
      en: 'Your session has ended. Please sign in again.',
      de: 'Deine Sitzung ist beendet. Bitte erneut anmelden.'
    }));
    return;
  }

  window.location.assign(buildApiUrl('/api/download').toString());
}

async function restoreStoredSession() {
  authContainer.style.visibility = 'hidden';

  const restored = await authenticate({ suppressErrors: true });

  authContainer.style.visibility = '';

  if (!restored) {
    showAuthView();
  }
}

document.getElementById('login-btn').addEventListener('click', handleLogin);
adminLoginButton.addEventListener('click', () => {
  const loginUrl = buildApiUrl('/auth/login');
  loginUrl.searchParams.set('returnTo', window.location.href);
  window.location.assign(loginUrl.toString());
});
passcodeInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') handleLogin();
});

document.getElementById('btn-lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'de' : 'en';
  persistLanguage();
  applyChrome();
  render();
});

document.getElementById('btn-view').addEventListener('click', () => {
  view = view === 'full' ? 'compact' : 'full';
  const url = new URL(window.location.href);
  if (view === 'full') url.searchParams.set('view', 'full');
  else url.searchParams.delete('view');
  history.replaceState(history.state, '', url);
  applyViewIcons();
  render();
});

document.getElementById('btn-theme').addEventListener('click', () => {
  theme = theme === 'light' ? 'dark' : 'light';
  persistTheme();
  document.documentElement.setAttribute('data-theme', theme);
  applyThemeIcons();
});

downloadButton.addEventListener('click', handleDownload);

function handleLogout() {
  const logoutUrl = buildApiUrl('/auth/logout');
  logoutUrl.searchParams.set('returnTo', window.location.href);
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = logoutUrl.toString();
  document.body.appendChild(form);
  form.submit();
}

logoutButton.addEventListener('click', handleLogout);

editButton.addEventListener('click', async () => {
  const { toggleEditor } = await import('./editor.js');
  toggleEditor();
});

function setMenuOpen(open) {
  toolbarWrap.classList.toggle('open', open);
  menuButton.setAttribute('aria-expanded', String(open));
}

menuButton.addEventListener('click', () => setMenuOpen(!toolbarWrap.classList.contains('open')));
// Choosing an action closes the menu; clicks outside or Escape dismiss it.
document.getElementById('toolbar').addEventListener('click', (event) => {
  if (event.target.closest('.tbtn')) setMenuOpen(false);
});
document.addEventListener('click', (event) => {
  if (!toolbarWrap.contains(event.target)) setMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && toolbarWrap.classList.contains('open')) {
    setMenuOpen(false);
    menuButton.focus();
  }
});

window.addEventListener('scroll', highlightCurrentSection, { passive: true });
window.addEventListener('resize', highlightCurrentSection);

createIcons({ icons: { Download, Languages, ListMinus, ListPlus, LogOut, Menu, Moon, SquarePen, Sun } });
lang = getStoredLanguage();
theme = getStoredTheme();
document.documentElement.setAttribute('data-theme', theme);
applyChrome();
restoreStoredSession();
