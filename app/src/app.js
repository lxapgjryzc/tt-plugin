// The background app (requirements R9): storage, the check loop, notifications, and the
// handlers behind the local API. Everything outside (fetch, Windows, the clock) is
// injected so tests can run it in-process against a fake platform.

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openDb } from './db.js';
import { makeStore } from './store.js';
import { makeKv, KEYS, pageSettingsPatch } from './kv.js';
import { makeTokens } from './tokens.js';
import { makeAutoLogin } from './auto-login.js';
import { makeApi } from './adapter.js';
import { runTick } from './engine.js';
import { withdrawRound } from './withdraw.js';
import { selectTerm, listAssignments, countPending, findAssignment, findNode, nodeSubmissions, label, resolveDialogNode } from './model.js';
import { canQueue, needsAttention } from './scheduler.js';
import { imageSetProblem } from './images.js';
import { loadMessages, format, PAGE_LOCALE } from './i18n.js';
import { sessionState, tokenExpiry, usable } from './session.js';
import { parseReviewHours, inReviewHours } from './review-hours.js';

const LOCALES_DIR = new URL('../_locales/', import.meta.url);
const readLocale = async (locale) => JSON.parse(await readFile(new URL(`${locale}/messages.json`, LOCALES_DIR), 'utf8'));
const STAGED_TTL_MS = 60 * 60_000; // staged images unused after this long are deleted

const ITEM_FINISHED = new Set(['done', 'continued', 'skipped', 'withdrawn']);
const NOTIFY_TITLES = { done: 'notifyApproved', needs_revision: 'notifyRevision', skipped: 'notifySkipped' };
const LOGIN_NOTE = 'chamber-login';

/**
 * opts = {
 *   dbFile, target, baseUrl (the queue page, for notification clicks),
 *   fetchImpl (or api: a ready API client, for tests), notifier: { show({ tag, title, body, url, sticky }), clear(tag) },
 *   secret: { protect, unprotect }, now(), osLanguage, setTimer, clearTimer, onQuit()
 * }
 */
export function makeApp(opts) {
  const {
    dbFile, target, fetchImpl, notifier, secret,
    now = () => Date.now(),
    osLanguage = Intl.DateTimeFormat().resolvedOptions().locale,
    setTimer = setTimeout, clearTimer = clearTimeout,
    onQuit = () => {},
  } = opts;
  let baseUrl = opts.baseUrl || '';

  const db = openDb(dbFile);
  const store = makeStore(db);
  const kv = makeKv(db, { now });
  const tokens = makeTokens(kv);
  const login = makeAutoLogin({ kv, secret, tokens });
  const api = opts.api || makeApi(target, fetchImpl ? { fetchImpl } : {});

  if (!kv.get(KEYS.appKey)) kv.set(KEYS.appKey, randomBytes(32).toString('base64url'));
  const appKey = kv.get(KEYS.appKey);

  // ---- change events (the queue pages listen, R9.11) ------------------------
  const listeners = new Set();
  const broadcast = () => { for (const fn of listeners) { try { fn(); } catch { /* listener gone */ } } };

  const deps = {
    target,
    api,
    store,
    settings: { get: kv.getSettings, set: kv.setSettings },
    lock: kv.lock,
    audit: async (entry) => {
      await kv.appendAudit(entry);
      if (entry.action === 'reconcile') notifyTransition(entry);
      else if (entry.result === 'preflight: reasonApproved') notifyTransition({ itemId: entry.itemId, result: 'uploading -> skipped' });
    },
    // With automatic login on, a missing, expired or soon-expiring token triggers a login.
    getToken: async () => {
      const token = tokens.get();
      if (sessionState({ token }) === 'ok') return token;
      return (await login.tryAutoLogin(api, { now: now() })) || token;
    },
    dropToken: () => tokens.store(null),
    saveSnapshot: async (snap) => kv.set(KEYS.snapshot, snap),
    now,
  };

  // ---- notifications (R9.15) ------------------------------------------------
  const messages = async () => loadMessages((await kv.getSettings()).locale, osLanguage, readLocale);
  const note = (n) => Promise.resolve().then(() => notifier.show({ url: `${baseUrl}/`, ...n })).catch(() => {});

  async function notifyTransition(entry) {
    const to = entry.result.split(' -> ')[1];
    if (!NOTIFY_TITLES[to]) return;
    const item = await store.getItem(entry.itemId);
    note({ tag: `chamber-${entry.itemId}-${to}`, title: format(await messages(), NOTIFY_TITLES[to]), body: item?.title || '' });
  }

  // The site's token lives exactly 24 h and cannot be refreshed, so warn an hour before it
  // expires and again (persistently) once it has. Each notice is shown once.
  async function checkSession() {
    const s = await kv.getSettings();
    const token = tokens.get();
    const shown = kv.get(KEYS.sessionNotice) ?? null;
    const state = sessionState({ token, sessionInvalid: s.sessionInvalid }, now());
    const exp = tokenExpiry(token);
    let notice = state === 'expiring' ? `expiring:${exp}` : state === 'ok' ? null : 'loggedOut';
    // Automatic login handles it; only speak up if it is off or failing.
    if (notice && await login.autoLoginActive()) notice = null;
    const failed = notice === 'loggedOut' && s.autoLogin ? (await login.loginStatus()).error : null;
    if (notice === shown) return;
    if (!notice) {
      kv.remove(KEYS.sessionNotice);
      Promise.resolve().then(() => notifier.clear(LOGIN_NOTE)).catch(() => {});
      return;
    }
    kv.set(KEYS.sessionNotice, notice);
    const m = await messages();
    const time = exp ? new Date(exp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    note({
      tag: LOGIN_NOTE,
      title: format(m, failed ? 'notifyAutoLoginFailedTitle' : notice === 'loggedOut' ? 'notifyLoggedOutTitle' : 'notifyExpiringTitle'),
      body: failed ? format(m, 'notifyAutoLoginFailedBody', [failed]) : format(m, notice === 'loggedOut' ? 'notifyLoggedOutBody' : 'notifyExpiringBody', [time]),
      sticky: notice === 'loggedOut',
    });
  }

  // ---- checks ---------------------------------------------------------------
  let running = null;
  let again = false;
  let stopped = false;

  async function tick({ manual = false } = {}) {
    if (stopped) return { why: 'stopped' };
    if (running) {
      if (!manual) {
        again = true;
        return running;
      }
      // A manual check must not be swallowed by an automatic one already in flight.
      await running.catch(() => {});
      return tick({ manual: true });
    }
    running = (async () => {
      try {
        const r = await runTick(deps, { manual });
        kv.set(KEYS.lastTick, { at: new Date(now()).toISOString(), ...r });
        return r;
      } finally {
        running = null;
        await checkSession().catch(() => {});
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
    if (stopped) return;
    clearTimer(soonTimer);
    soonTimer = setTimer(() => tick(), ms);
  }

  // Periodic checks (R9.5). Outside review hours no slot can free up, so the periodic
  // check is skipped; anything the user does still checks at once. A timer that fires
  // more than a period late means the computer was asleep: check at once, whatever the
  // hour, since slots may have freed meanwhile.
  let loopTimer = null;
  let expectedAt = null;
  async function periodic() {
    const s = await kv.getSettings();
    const period = Math.max(30, s.tickSeconds) * 1000;
    const late = expectedAt !== null && now() - expectedAt > period;
    if (!late && s.reviewHoursOn && !inReviewHours(parseReviewHours(s.reviewHours), now())) {
      const snap = kv.get(KEYS.snapshot);
      if (snap && snap.why !== 'restHours') kv.set(KEYS.snapshot, { ...snap, why: 'restHours' });
      await checkSession().catch(() => {});
      broadcast();
    } else {
      if (late) await kv.appendAudit({ action: 'wake', result: 'check after sleep' });
      await tick().catch(() => {});
    }
  }
  async function schedule() {
    if (stopped) return;
    const s = await kv.getSettings();
    const period = Math.max(30, s.tickSeconds) * 1000;
    expectedAt = now() + period;
    clearTimer(loopTimer);
    loopTimer = setTimer(async () => {
      try { await periodic(); } finally { schedule(); }
    }, period);
  }

  // ---- term data --------------------------------------------------------------
  async function loadTree() {
    const token = await deps.getToken();
    if (!token) return { error: 'NO_TAB' };
    api.setToken(token);
    try {
      const courses = await api.courses();
      const s = await kv.getSettings();
      const termId = s.activeTermId || selectTerm(courses)?.termId;
      if (!termId) return { courses, term: null };
      const term = await api.weeks(String(termId));
      return { courses, term };
    } catch (e) {
      if (e?.status === 401) {
        await kv.setSettings({ sessionInvalid: true });
        return { error: 'SESSION_INVALID' };
      }
      return { error: e?.message || String(e) };
    }
  }

  // Find the (assignment, node) a site page refers to. Returns { assignment, node } or { error }.
  async function locateNode(term, where) {
    let assignmentId = where.assignmentId;
    let nodeId;
    if (where.dialog) {
      if (String(where.termId) !== String(term.termId)) return { error: 'reasonOtherTerm' };
      let catalog;
      try {
        catalog = await api.catalog(String(term.termId));
      } catch (e) {
        return { error: e?.message || String(e) };
      }
      const hit = resolveDialogNode(catalog, where.dialog);
      if (hit.error) return hit;
      ({ assignmentId, nodeId } = hit);
    }
    const a = findAssignment(term, assignmentId);
    if (!a) return { error: 'reasonAssignmentMissing' };
    if (!(a.nodes || []).length) return { assignment: a, node: null };
    const node = where.dialog
      ? findNode(a, nodeId)
      : a.nodes.find((n) => n.title === where.nodeTitle) || a.nodes.find((n) => n.nodeOrder === where.nodeOrder);
    return node ? { assignment: a, node } : { error: 'reasonNodeMissing' };
  }

  // ---- status for the extension's toolbar badge (R9.19) -----------------------
  async function badge() {
    const [s, backlog] = [await kv.getSettings(), await store.listBacklog()];
    const snap = kv.get(KEYS.snapshot) || null;
    const revision = needsAttention(backlog).length;
    const loggedOut = ['expired', 'invalid', 'missing'].includes(sessionState({ token: tokens.get(), sessionInvalid: s.sessionInvalid }, now()));
    let text = '';
    if (loggedOut) text = '!';
    else if (s.paused) text = '||';
    else if (revision) text = String(revision);
    else if (snap?.limit != null) text = `${snap.pending.length}/${snap.limit}`;
    return { text, alert: loggedOut || !!revision || s.paused };
  }

  // Staged images must exist, be unused, and form a valid set (R1.2).
  async function checkStaged(imageIds) {
    if (!Array.isArray(imageIds)) return 'errNoImage';
    const meta = [];
    for (const id of imageIds) {
      const img = store.imageBytes(id);
      if (!img) return 'reasonImageMissing';
      meta.push({ type: img.mime, size: img.bytes.byteLength });
    }
    const used = new Set((await store.listBacklog()).flatMap((i) => i.imageIds || []));
    if (imageIds.some((id) => used.has(id))) return 'reasonImageMissing';
    return imageSetProblem(target, meta);
  }

  const changed = (ms) => { broadcast(); tickSoon(ms); };

  // ---- handlers: queue page --------------------------------------------------
  const page = {
    async state() {
      return {
        settings: await kv.getSettings(), backlog: await store.listBacklog(),
        snapshot: kv.get(KEYS.snapshot) || null, lastTick: kv.get(KEYS.lastTick) || null,
      };
    },
    tree: () => loadTree(),
    tick: async ({ manual }) => tick({ manual: !!manual }),
    audit: () => kv.getAudit(),
    async settings({ patch }) {
      const next = await kv.setSettings(pageSettingsPatch(patch));
      schedule();
      broadcast();
      if (patch && ('paused' in patch || 'autoSubmit' in patch) && !next.paused) tickSoon(300);
      return next;
    },
    loginStatus: () => login.loginStatus(),
    async saveLogin({ enabled, account, password }) {
      const res = await login.saveLogin({ enabled, account, password });
      if (res.saved && enabled) {
        const token = await login.tryAutoLogin(api, { force: true, now: now() });
        if (token) tickSoon(300);
      }
      await checkSession();
      broadcast();
      return { ...(await login.loginStatus()), saveRefused: res.saved ? null : res.reason };
    },
    async forgetLogin() {
      await login.forgetLogin();
      await checkSession();
      broadcast();
      return login.loginStatus();
    },
    // After the user confirmed this exact round (R6). Replacement images were staged by the
    // page beforehand; they are discarded on refusal.
    async withdraw({ assignmentId, nodeId, submissionId, replacement }) {
      if (replacement?.imageIds?.length) {
        const bad = await checkStaged(replacement.imageIds);
        if (bad) return { ok: false, reason: bad };
      }
      const res = await withdrawRound(deps, { assignmentId, nodeId, submissionId, replacement: replacement || null });
      if (!res.ok && replacement?.imageIds?.length) await store.discardImages(replacement.imageIds);
      broadcast();
      if (res.ok) tickSoon(300); // use the freed slot
      return res;
    },
    async enqueue({ imageIds, assignmentId, nodeId, title, roundsAtQueue }) {
      const bad = await checkStaged(imageIds);
      if (bad) return { error: bad };
      const nid = nodeId == null ? null : String(nodeId);
      const { item, replaced } = await store.enqueue({
        imageIds, assignmentId: String(assignmentId), nodeId: nid, title: String(title || ''), roundsAtQueue: roundsAtQueue ?? null,
      });
      kv.set(KEYS.lastPick, { assignmentId: String(assignmentId), nodeId: nid, label: item.title });
      await kv.appendAudit({ action: 'enqueue', itemId: item.id, assignmentId: String(assignmentId), nodeId: nid, result: replaced ? 'replaced' : 'added', images: imageIds.length, source: 'queue page' });
      changed();
      return { ok: true, id: item.id, replaced };
    },
    async replaceImages({ id, imageIds, roundsAtQueue }) {
      const bad = await checkStaged(imageIds);
      if (bad) return { error: bad };
      const item = await store.replaceImages(id, { imageIds }, roundsAtQueue ?? null);
      if (!item) { await store.discardImages(imageIds); return { error: 'reasonBusy' }; }
      changed();
      return { ok: true };
    },
    async reorder({ ids }) { await store.reorder((ids || []).map(String)); changed(); return { ok: true }; },
    async remove({ id }) { const ok = await store.removeItem(id); changed(); return { ok }; },
    async retry({ id, roundsAtQueue }) {
      // Retrying is the user's decision to send this drawing anyway, so the node's current
      // round count is the new baseline for the submitted-elsewhere check.
      const ok = !!(await store.patchItem(id, { status: 'queued', reason: null, reasonDetail: null, attempts: 0, nextAttemptAt: null, roundsAtQueue: roundsAtQueue ?? null }, ['blocked', 'failed']));
      changed();
      return { ok };
    },
    async clearFinished() {
      for (const i of await store.listBacklog()) if (ITEM_FINISHED.has(i.status)) await store.removeItem(i.id);
      broadcast();
      return { ok: true };
    },
    async quit() {
      setTimer(() => onQuit(), 50);
      return { ok: true };
    },
  };

  // ---- handlers: the extension (R9.16-R9.19) ----------------------------------
  const site = {
    async token({ token }) {
      if (usable(token, now())) {
        if (tokens.offer(token)) {
          await kv.setSettings({ sessionInvalid: false });
          tickSoon(); // a fresh login: resume
        }
      } else if (!token && !(await kv.getSettings()).autoLogin && tokens.get()) {
        // Logged out on the site: forget our copy too. (An expired token on the page is
        // ignored; with automatic login on, we keep our own session.)
        tokens.store(null);
      } else {
        return { ok: true };
      }
      await checkSession();
      broadcast();
      return { ok: true };
    },
    // The session obtained by automatic login, to restore the site's own login when it has
    // expired. Only given out while automatic login is on.
    async session() {
      if (!(await kv.getSettings()).autoLogin) return null;
      const session = kv.get(KEYS.siteSession);
      return session && usable(session.token, now()) ? session : null;
    },
    async lookup({ assignmentId }) {
      const { term, error } = await loadTree();
      if (error) return { error };
      if (!term) return { error: 'NOT_FOUND' };
      const a = listAssignments(term).find((x) => String(x.assignment.assignmentId) === String(assignmentId))?.assignment;
      return a ? { title: a.title, nodes: (a.nodes || []).map((n) => ({ nodeId: n.nodeId, title: n.title, status: n.status, locked: n.locked })) } : { error: 'NOT_FOUND' };
    },
    async badge() {
      return { ...(await badge()), lastPick: kv.get(KEYS.lastPick) || null, snapshot: kv.get(KEYS.snapshot) || null };
    },
    async pageNav() { tickSoon(); return { ok: true }; },
    async strings() { return (await readLocale(PAGE_LOCALE).catch(() => null)) || {}; },
    // Queue the image(s) the user put in one of the site's upload boxes. `where` is
    // { assignmentId, nodeOrder, nodeTitle } on the assignment page, or
    // { termId, dialog: { chapterTitle, typeLabel, nodeTitle } } from the learning page's
    // submit dialog. `images` are [{ dataUrl, name }]. Same checks as the queue page.
    async enqueue({ where, images }) {
      const parts = [];
      for (const img of images || []) {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(img?.dataUrl || ''));
        if (!m) return { error: 'errNotImage' };
        parts.push({ data: Buffer.from(m[2], 'base64'), mime: m[1], name: String(img.name || 'drawing') });
      }
      const bad = imageSetProblem(target, parts.map((p) => ({ type: p.mime, size: p.data.byteLength })));
      if (bad) return { error: bad };
      const { term, error } = await loadTree();
      if (error) return { error };
      if (!term) return { error: 'why_noTerm' };
      const found = await locateNode(term, where || {});
      if (found.error) return found;
      const { assignment: a, node } = found;
      const backlog = await store.listBacklog();
      const verdict = canQueue(target, term, backlog, a, node);
      if (!verdict.ok) return { error: verdict.reason, detail: verdict.detail ?? null };
      const nodeId = node ? String(node.nodeId) : null;
      const title = label(a, node);
      const { item, replaced } = await store.enqueue({
        images: parts, assignmentId: String(a.assignmentId), nodeId, title, roundsAtQueue: nodeSubmissions(a, nodeId).length,
      });
      kv.set(KEYS.lastPick, { assignmentId: String(a.assignmentId), nodeId, label: title });
      await kv.appendAudit({ action: 'enqueue', itemId: item.id, assignmentId: String(a.assignmentId), nodeId, result: replaced ? 'replaced' : 'added', images: parts.length, source: 'site' });
      changed();
      return { ok: true, title, replaced, chained: !!verdict.chained, followUp: !!verdict.followUp };
    },
  };

  // ---- read-only probe (debugging) ----------------------------------------------
  async function probe() {
    const { term, error } = await loadTree();
    if (error) return { error };
    if (!term) return { term: null };
    return {
      termId: term.termId, termName: term.termName, maxPendingSubmissions: term.maxPendingSubmissions,
      pending: countPending(target, term),
      assignments: listAssignments(term).map(({ assignment: a }) => ({
        assignmentId: a.assignmentId, title: a.title, status: a.status, blocked: !!a.blockedReason,
        nodes: (a.nodes || []).map((n) => ({ nodeId: n.nodeId, order: n.nodeOrder, status: n.status, locked: n.locked })),
      })),
    };
  }

  return {
    appKey,
    store,
    kv,
    tokens,
    deps,
    page,
    site,
    probe,
    tick,
    tickSoon,
    setBaseUrl: (u) => { baseUrl = u; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    broadcast,
    // Start the loop: an immediate check, then every tickSeconds.
    async start() {
      await store.gcImages(STAGED_TTL_MS, now());
      await checkSession().catch(() => {});
      tickSoon(500);
      await schedule();
    },
    // Stop timers, let a running check finish (it never leaves a half-written state, and
    // a kill would be handled like an eviction anyway), then close the database.
    async stop() {
      stopped = true;
      clearTimer(loopTimer);
      clearTimer(soonTimer);
      await running?.catch(() => {});
      listeners.clear();
      db.close();
    },
  };
}
