// Service worker: alarm loop, message hub, token sync. Holds no scheduling state in
// memory; every tick re-reads IndexedDB and the API.

import { target } from './target.js';
import { makeApi } from './adapter.js';
import { runTick } from './engine.js';
import { selectTerm, listAssignments, countPending, findAssignment, nodeSubmissions, label } from './model.js';
import { canQueue } from './scheduler.js';
import { loadMessages, format, PAGE_LOCALE } from './i18n.js';
import { getToken, storeToken, usable } from './token-bridge.js';
import { sessionState, tokenExpiry } from './session.js';
import * as store from './storage/idb.js';
import {
  KEYS, getSettings, setSettings, appendAudit, getAudit, acquireLock, refreshLock, releaseLock,
} from './storage/settings.js';

const ALARM = 'chamber:tick';
const api = makeApi(target);

const deps = {
  target,
  api,
  store,
  settings: { get: getSettings, set: setSettings },
  lock: { acquire: acquireLock, refresh: refreshLock, release: releaseLock },
  audit: async (entry) => {
    await appendAudit(entry);
    if (entry.action === 'reconcile') notifyTransition(entry);
  },
  getToken,
  dropToken: () => storeToken(null),
  saveSnapshot: (snap) => chrome.storage.local.set({ [KEYS.snapshot]: snap }),
  now: () => Date.now(),
};

// ---- Origin header ------------------------------------------------------
// The platform's CORS filter answers `403 Invalid CORS request` to any request whose
// Origin is chrome-extension://…. Chrome omits Origin on the worker's GETs but sends
// it on POST/PUT, so uploads and submissions would fail. Strip it from requests the
// worker makes (they have no tab) to the API; page requests are untouched.
const ORIGIN_RULE_ID = 1;
const originRuleReady = chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [ORIGIN_RULE_ID],
  addRules: [{
    id: ORIGIN_RULE_ID,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      urlFilter: `|${target.base}/api/`,
      tabIds: [chrome.tabs.TAB_ID_NONE],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  }],
});

// ---- tick ---------------------------------------------------------------

let running = null;
let again = false;

async function tick({ manual = false } = {}) {
  if (running) {
    if (!manual) {
      again = true;
      return running;
    }
    // A manual check must not be swallowed by an automatic one already in flight
    // (e.g. the one triggered by Retry): wait for it, then run our own.
    await running.catch(() => {});
    return tick({ manual: true });
  }
  running = (async () => {
    try {
      await originRuleReady;
      const r = await runTick(deps, { manual });
      await chrome.storage.local.set({ [KEYS.lastTick]: { at: new Date().toISOString(), ...r } });
      return r;
    } finally {
      running = null;
      await refreshBadge();
      await checkSession();
      broadcast();
    }
  })();
  const r = await running;
  if (again) {
    again = false;
    queueMicrotask(() => tick());
  }
  return r;
}

let soonTimer = null;
function tickSoon(ms = 1500) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => tick(), ms);
}

async function ensureAlarm() {
  const s = await getSettings();
  const period = Math.max(30, s.tickSeconds) / 60;
  const cur = await chrome.alarms.get(ALARM);
  if (!cur || Math.abs(cur.periodInMinutes - period) > 1e-6) {
    await chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: period });
  }
}

function broadcast() {
  chrome.runtime.sendMessage({ type: 'chamber:changed' }).catch(() => {});
}

// ---- action badge & notifications --------------------------------------

async function refreshBadge() {
  const [s, backlog, { [KEYS.snapshot]: snap, [KEYS.token]: token }] = await Promise.all([
    getSettings(), store.listBacklog(), chrome.storage.local.get([KEYS.snapshot, KEYS.token]),
  ]);
  const revision = backlog.filter((i) => i.status === 'needs_revision' || i.status === 'blocked' || i.status === 'failed').length;
  const loggedOut = ['expired', 'invalid', 'missing'].includes(sessionState({ token, sessionInvalid: s.sessionInvalid }));
  let text = '';
  if (loggedOut) text = '!';
  else if (s.paused) text = '||';
  else if (revision) text = String(revision);
  else if (snap?.limit != null) text = `${snap.pending.length}/${snap.limit}`;
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: loggedOut || revision || s.paused ? '#c2410c' : '#1c1c1c' });
}

// ---- login reminders ----------------------------------------------------
// The site's token lives exactly 24 h and cannot be refreshed, so warn an hour
// before it expires and again (persistently) once it has. Each notice is shown once.
const LOGIN_NOTE = 'chamber-login';

async function checkSession() {
  const s = await getSettings();
  const { [KEYS.token]: token, [KEYS.sessionNotice]: shown } = await chrome.storage.local.get([KEYS.token, KEYS.sessionNotice]);
  const state = sessionState({ token, sessionInvalid: s.sessionInvalid });
  const exp = tokenExpiry(token);
  const notice = state === 'expiring' ? `expiring:${exp}` : state === 'ok' ? null : 'loggedOut';
  if (notice === (shown ?? null)) return;
  if (!notice) {
    await chrome.storage.local.remove(KEYS.sessionNotice);
    chrome.notifications.clear(LOGIN_NOTE);
    return;
  }
  await chrome.storage.local.set({ [KEYS.sessionNotice]: notice });
  const messages = await loadMessages(s.locale);
  const time = exp ? new Date(exp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  chrome.notifications.create(LOGIN_NOTE, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/128.png'),
    title: format(messages, notice === 'loggedOut' ? 'notifyLoggedOutTitle' : 'notifyExpiringTitle'),
    message: format(messages, notice === 'loggedOut' ? 'notifyLoggedOutBody' : 'notifyExpiringBody', [time]),
    requireInteraction: notice === 'loggedOut',
  });
}

async function notifyTransition(entry) {
  const to = entry.result.split(' -> ')[1];
  if (!['needs_revision', 'done'].includes(to)) return;
  const item = await store.getItem(entry.itemId);
  const messages = await loadMessages((await getSettings()).locale);
  chrome.notifications.create(`chamber-${entry.itemId}-${to}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/128.png'),
    title: format(messages, to === 'done' ? 'notifyApproved' : 'notifyRevision'),
    message: item?.title || '',
  });
}

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  if (id === LOGIN_NOTE) chrome.tabs.create({ url: `${target.base}/` });
  else openQueue();
});

async function openQueue(query = '') {
  const url = chrome.runtime.getURL(`ui/options.html${query}`);
  const [tab] = await chrome.tabs.query({ url: chrome.runtime.getURL('ui/options.html*') });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true, ...(query ? { url } : {}) });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// ---- read-only probe ----------------------------------------------------

async function loadTree() {
  await originRuleReady;
  const token = await getToken();
  if (!token) return { error: 'NO_TAB' };
  api.setToken(token);
  try {
    const courses = await api.courses();
    const s = await getSettings();
    const termId = s.activeTermId || selectTerm(courses)?.termId;
    if (!termId) return { courses, term: null };
    const term = await api.weeks(String(termId));
    return { courses, term };
  } catch (e) {
    if (e?.status === 401) {
      await setSettings({ sessionInvalid: true });
      return { error: 'SESSION_INVALID' };
    }
    return { error: e?.message || String(e) };
  }
}

async function probe() {
  const { term, error } = await loadTree();
  if (error) return { error };
  return {
    termId: term.termId,
    termName: term.termName,
    maxPendingSubmissions: term.maxPendingSubmissions,
    pending: countPending(target, term),
    assignments: listAssignments(term).map(({ assignment: a }) => ({
      assignmentId: a.assignmentId,
      title: a.title,
      status: a.status,
      blocked: !!a.blockedReason,
      nodes: (a.nodes || []).map((n) => ({ nodeId: n.nodeId, order: n.nodeOrder, status: n.status, locked: n.locked })),
    })),
  };
}

self.chamber = { probe, tick, getAudit, getSettings, setSettings, listBacklog: store.listBacklog };

// ---- messages -----------------------------------------------------------

const handlers = {
  'chamber:token': async ({ token }, sender) => {
    if (!sender.url?.startsWith(target.base)) return { ok: false };
    // The site may still hold an expired token until its next API call logs it out.
    const next = usable(token) ? token : null;
    const prev = (await chrome.storage.local.get(KEYS.token))[KEYS.token];
    if (next === prev) return { ok: true };
    await storeToken(next);
    if (next) tickSoon(); // a fresh login: resume (the tick clears sessionInvalid)
    await refreshBadge();
    await checkSession();
    return { ok: true };
  },
  'chamber:pageNav': async () => { tickSoon(); return { ok: true }; },
  // tenten.art is Chinese-only, so everything injected into it uses PAGE_LOCALE.
  'chamber:pageStrings': async () => (await loadMessages(PAGE_LOCALE)) || {},
  'chamber:tick': async ({ manual }) => tick({ manual: !!manual }),
  'chamber:tree': () => loadTree(),
  'chamber:settings': async ({ patch }) => {
    const next = await setSettings(patch || {});
    await ensureAlarm();
    await refreshBadge();
    broadcast();
    if (patch && ('paused' in patch || 'autoSubmit' in patch) && !next.paused) tickSoon(300);
    return next;
  },
  'chamber:itemsChanged': async () => { await refreshBadge(); broadcast(); tickSoon(); return { ok: true }; },
  'chamber:openQueue': async ({ query }) => { await openQueue(query || ''); return { ok: true }; },
  // From the site's own assignment page: queue the image the user put in the site's
  // upload box for the node they are viewing. Same checks as the queue page.
  'chamber:enqueue': async ({ assignmentId, nodeOrder, nodeTitle, dataUrl, name }, sender) => {
    if (!sender.url?.startsWith(target.base)) return { error: 'reasonAssignmentMissing' };
    const { term, error } = await loadTree();
    if (error) return { error };
    const a = findAssignment(term, assignmentId);
    if (!a) return { error: 'reasonAssignmentMissing' };
    let node = null;
    if ((a.nodes || []).length) {
      node = a.nodes.find((n) => n.title === nodeTitle) || a.nodes.find((n) => n.nodeOrder === nodeOrder);
      if (!node) return { error: 'reasonNodeMissing' };
    }
    const blob = await (await fetch(dataUrl)).blob();
    if (!blob.type.startsWith('image/') || blob.size === 0) return { error: 'errNotImage' };
    if (blob.size > target.maxUploadBytes) return { error: 'errTooLarge' };
    const backlog = await store.listBacklog();
    const verdict = canQueue(target, term, backlog, a, node);
    if (!verdict.ok) return { error: verdict.reason, detail: verdict.detail ?? null };
    const nodeId = node ? String(node.nodeId) : null;
    const title = label(a, node);
    const { replaced } = await store.enqueue({
      blob, name, assignmentId: String(a.assignmentId), nodeId, title, roundsAtQueue: nodeSubmissions(a, nodeId).length,
    });
    await chrome.storage.local.set({ 'chamber:lastPick': { assignmentId: String(a.assignmentId), nodeId, label: title } });
    await appendAudit({ action: 'enqueue', assignmentId: String(a.assignmentId), nodeId, result: replaced ? 'replaced' : 'added', source: 'page' });
    await refreshBadge();
    broadcast();
    tickSoon();
    return { ok: true, title, replaced, chained: !!verdict.chained };
  },
  'chamber:lookup': async ({ assignmentId }) => {
    const { term, error } = await loadTree();
    if (error) return { error };
    const a = listAssignments(term).find((x) => String(x.assignment.assignmentId) === String(assignmentId))?.assignment;
    return a ? { title: a.title, nodes: (a.nodes || []).map((n) => ({ nodeId: n.nodeId, title: n.title, status: n.status, locked: n.locked })) } : { error: 'NOT_FOUND' };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h(msg, sender)).then(reply, (e) => reply({ error: e?.message || String(e) }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) tick(); });
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); tickSoon(500); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); tickSoon(500); });
ensureAlarm();
refreshBadge().then(checkSession).catch(() => {});
