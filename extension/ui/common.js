// Shared helpers for extension pages. All copy comes from _locales via t().

import { target } from '../src/target.js';
import { loadMessages, format, effectiveLocale } from '../src/i18n.js';
import { getSettings } from '../src/storage/settings.js';

let messages = null;
let locale = 'auto';

// Call once before rendering: loads the language chosen in settings.
export async function initI18n() {
  locale = (await getSettings()).locale;
  messages = await loadMessages(locale);
}

export const t = (key, subs) => format(messages, key, subs);

export function applyI18n(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
  document.documentElement.lang = effectiveLocale(locale);
}

export const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

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

// Re-render on any backend change.
export function onChanged(fn) {
  let timer = null;
  const fire = () => { clearTimeout(timer); timer = setTimeout(fn, 50); };
  chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'chamber:changed') fire(); });
  chrome.storage.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((k) => k.startsWith('chamber:'))) fire();
  });
}

export function openSite() {
  chrome.tabs.create({ url: `${target.base}/` });
}

export function why(key) {
  return key ? t(`why_${key}`) : '';
}
