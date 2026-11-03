// Shared helpers for the queue page, served by the app (requirements R9.11). All copy
// comes from _locales via t(); all data goes through the app's local API.

import { target } from '../src/target.js';
import { loadMessages, format, effectiveLocale } from '../src/i18n.js';

// The app embeds its API key in this page's HTML (R9.12).
const KEY = document.querySelector('meta[name="chamber-key"]')?.content || '';

let messages = null;
let locale = 'auto';

// Set when the app cannot be reached (it was quit or crashed); the page shows a banner.
export const connection = { down: false, onChange: () => {} };
function setDown(down) {
  if (connection.down === down) return;
  connection.down = down;
  connection.onChange(down);
}

async function request(path, init = {}) {
  let res;
  try {
    res = await fetch(path, { ...init, headers: { 'X-Chamber-Key': KEY, ...(init.headers || {}) } });
  } catch (e) {
    setDown(true);
    throw e;
  }
  setDown(false);
  return res;
}

// Call a queue-page handler of the app. Resolves with its JSON result.
export async function send(type, payload = {}) {
  const res = await request(`/api/call/${type}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

// Store one image file in the app ahead of queuing it; resolves with its id.
export async function stageImage(file, name) {
  const res = await request('/api/images', {
    method: 'POST', body: file, headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(name) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).id;
}

// An image's stored thumbnail ('thumb') or original ('data') as a Blob, or null.
export async function imageBlob(id, which) {
  const res = await request(`/api/images/${encodeURIComponent(id)}${which === 'thumb' ? '/thumb' : ''}`);
  return res.ok ? res.blob() : null;
}

export async function saveThumb(id, blob) {
  await request(`/api/images/${encodeURIComponent(id)}/thumb`, { method: 'PUT', body: blob });
}

const readLocale = async (l) => {
  const res = await fetch(`/_locales/${l}/messages.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Call once before rendering: loads the language chosen in settings.
export async function initI18n() {
  try { locale = (await send('state')).settings.locale; } catch { locale = 'auto'; }
  messages = await loadMessages(locale, navigator.language, readLocale);
}

export const t = (key, subs) => format(messages, key, subs);

export function applyI18n(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
  document.documentElement.lang = effectiveLocale(locale, navigator.language);
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const ICONS = {
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  grip: '<path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" stroke-width="2"/>',
  image: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5"/>',
  external: '<path d="M9 3h4v4M13 3L7 9M11 9.5V13H3V5h3.5"/>',
};
export function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

// ---- status vocabulary ----------------------------------------------------

const ITEM_STATUS = {
  queued: ['stQueued', null],
  uploading: ['stUploading', 'accent'],
  submitting: ['stSubmitting', 'accent'],
  pending: ['stPending', 'strong'],
  needs_revision: ['stRevision', 'accent'],
  done: ['stDone', 'strong'],
  blocked: ['stBlocked', 'accent'],
  failed: ['stFailed', 'accent'],
  continued: ['stContinued', 'faint'],
  skipped: ['stSkipped', 'faint'],
  withdrawn: ['stWithdrawn', 'faint'],
};
export function itemStatusText(status) {
  return t((ITEM_STATUS[status] || [status])[0]);
}

export function itemTag(status) {
  const [key, tone] = ITEM_STATUS[status] || [status, null];
  return el('span', { class: 'tag', 'data-tone': tone, text: t(key) });
}

const NODE_STATUS = {
  SUBMITTED: ['nsSubmitted', 'strong'],
  REVIEWING: ['nsReviewing', 'strong'],
  REVIEWED: ['nsReviewed', 'accent'],
  RETURNED: ['nsReturned', 'accent'],
  SHELVED: ['nsShelved', 'accent'],
  APPROVED: ['nsApproved', null],
};
export function nodeTag(status, locked) {
  if (locked && !status) return el('span', { class: 'tag', 'data-tone': 'faint', text: t('nsLocked') });
  if (!status) return el('span', { class: 'tag', 'data-tone': 'faint', text: t('nsNone') });
  const [key, tone] = NODE_STATUS[status] || [null, null];
  return el('span', { class: 'tag', 'data-tone': tone, text: key ? t(key) : status });
}

export const TYPE_KEYS = {
  BASIC: 'typeBasic', EXTENDED: 'typeExtended', ADVANCED: 'typeAdvanced',
  BI_WEEKLY: 'typeBiWeekly', GRADUATION: 'typeGraduation', DRILL: 'typeDrill',
};

// Reason keys are message names; server text is shown verbatim alongside.
export function reasonText(reason, detail) {
  if (!reason) return detail || '';
  const base = t(reason);
  return detail ? `${base}: ${detail}` : base;
}

// Mirrors the platform's own queue hint.
export function queueText(queuePosition, estimatedWaitMinutes) {
  if (!queuePosition) return '';
  const ahead = queuePosition - 1;
  if (ahead <= 0) return t('queueNext');
  const m = estimatedWaitMinutes;
  if (m == null || m <= 0) return t('queueAheadNoEta', [String(ahead)]);
  let eta;
  if (m < 60) eta = t('etaMinutes', [String(m)]);
  else if (m % 60) eta = t('etaHoursMinutes', [String(Math.floor(m / 60)), String(m % 60)]);
  else eta = t('etaHours', [String(m / 60)]);
  return t('queueAhead', [String(ahead), eta]);
}

export function relTime(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return t('agoSeconds', [String(Math.max(0, s))]);
  if (s < 3600) return t('agoMinutes', [String(Math.round(s / 60))]);
  return new Date(iso).toLocaleString();
}

export function renderPips(container, used, limit) {
  container.replaceChildren();
  if (limit == null) return;
  for (let i = 0; i < limit; i++) container.append(el('span', { class: `pip${i < used ? ' on' : ''}` }));
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', t('slotsFree', [String(Math.max(0, limit - used)), String(limit)]));
}

// Re-render on any change in the app (server-sent events over fetch, so the key can go in
// a header). Reconnects after the app restarts.
export function onChanged(fn) {
  let timer = null;
  const fire = () => { clearTimeout(timer); timer = setTimeout(fn, 50); };
  (async function listen() {
    for (;;) {
      try {
        const res = await request('/api/events');
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        fire(); // catch up on anything missed while disconnected
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.includes('data:')) fire();
        }
        setDown(true);
      } catch {
        setDown(true);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
}

export function openSite() {
  window.open(`${target.base}/`, '_blank', 'noopener');
}

export function why(key) {
  return key ? t(`why_${key}`) : '';
}
