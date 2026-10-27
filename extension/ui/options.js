import {
  t, initI18n, applyI18n, send, el, icon, itemTag, itemStatusText, nodeTag, TYPE_KEYS, reasonText, queueText, relTime, renderPips, onChanged, openSite, why,
} from './common.js';
import * as store from '../src/storage/idb.js';
import { KEYS, getSettings, getAudit } from '../src/storage/settings.js';
import { target } from '../src/target.js';
import { listAssignments, findAssignment, findNode, nodeStatus, nodeSubmissions, label } from '../src/model.js';
import { prioritize, priorityOf, canQueue } from '../src/scheduler.js';

const $ = (id) => document.getElementById(id);
const TREE_TTL = 30_000;

const state = {
  term: null,
  treeAt: 0,
  treeError: null,
  backlog: [],
  settings: null,
  snap: null,
  image: null, // { blob, name }
  selected: null, // { assignmentId, nodeId }
  thumbs: new Map(), // imageId -> object URL
  replaceId: null,
};

// ---------------------------------------------------------------------------
// Client-side eligibility for the picker. No network: works on the cached tree.

function pickState(assignment, node) {
  return canQueue(target, state.term, state.backlog, assignment, node);
}

// ---------------------------------------------------------------------------
// Data loading

async function loadTree(force = false) {
  if (!force && Date.now() - state.treeAt < TREE_TTL) return;
  state.treeAt = Date.now();
  const res = await send('chamber:tree');
  state.treeError = res?.error || null;
  if (res?.term) state.term = res.term;
  if (res?.courses?.length && res.term) {
    $('termLine').textContent = `${res.term.courseName} · ${res.term.termName}`;
  }
}

async function loadLocal() {
  const [settings, backlog, local] = await Promise.all([getSettings(), store.listBacklog(), chrome.storage.local.get([KEYS.snapshot, KEYS.lastTick])]);
  state.settings = settings;
  state.backlog = backlog;
  state.snap = local[KEYS.snapshot] || null;
  state.lastTick = local[KEYS.lastTick] || null;
}

// ---------------------------------------------------------------------------
// Header, controls, banner

function renderHeader() {
  const { snap, settings } = state;
  const limit = state.term ? Number(state.term.maxPendingSubmissions) : snap?.limit ?? null;
  const used = snap?.pending?.length ?? 0;
  renderPips($('pips'), used, limit);
  $('slotsText').textContent = limit == null ? t('slotsUnknown') : t('slotsFree', [String(Math.max(0, limit - used)), String(limit)]);
  const parts = [why(snap?.why)];
  if (state.lastTick?.at) parts.push(t('lastChecked', [relTime(state.lastTick.at)]));
  $('whyText').textContent = parts.filter(Boolean).join(' · ');

  const err = state.treeError || snap?.error;
  const needsLogin = err === 'NO_TAB' || err === 'SESSION_INVALID' || settings.sessionInvalid;
  $('banner').hidden = !needsLogin && !err;
  $('bannerAction').hidden = !needsLogin;
  if (needsLogin) $('bannerText').textContent = t(settings.sessionInvalid || err === 'SESSION_INVALID' ? 'sessionInvalid' : 'noTab');
  else if (err) $('bannerText').textContent = t('loadError', [String(err)]);

  $('pauseBtn').textContent = t(settings.paused ? 'resumeAll' : 'pauseAll');
  $('pauseBtn').classList.toggle('danger', settings.paused);
  $('autoSubmit').checked = settings.autoSubmit;
  $('dryRun').checked = settings.dryRun;
  $('tickSeconds').value = String(settings.tickSeconds);
  $('locale').value = settings.locale;
  const hint = settings.paused ? 'hintPaused' : settings.dryRun ? 'hintDryRun' : settings.autoSubmit ? 'hintAuto' : 'hintManual';
  $('modeHint').textContent = t(hint);
  $('runOnce').disabled = settings.paused;
}

// ---------------------------------------------------------------------------
// Backlog

function thumbFor(item) {
  const url = state.thumbs.get(item.imageId);
  if (url) return el('img', { class: 'thumb', src: url, alt: '' });
  const ph = el('div', { class: 'thumb ph' }, icon('image'));
  store.getImage(item.imageId).then((img) => {
    if (!img?.blob) return;
    const u = URL.createObjectURL(img.blob);
    state.thumbs.set(item.imageId, u);
    ph.replaceWith(el('img', { class: 'thumb', src: u, alt: '' }));
  });
  return ph;
}

function gcThumbs() {
  const live = new Set(state.backlog.map((i) => i.imageId));
  for (const [id, url] of state.thumbs) if (!live.has(id)) { URL.revokeObjectURL(url); state.thumbs.delete(id); }
}

async function itemsChanged() {
  await send('chamber:itemsChanged');
  await refresh();
}

async function move(id, delta) {
  const ids = state.backlog.map((i) => i.id);
  const at = ids.indexOf(id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(at, 1)[0]);
  await store.reorder(ids);
  await itemsChanged();
  document.querySelector(`li.row[data-id="${id}"]`)?.focus();
}

function itemRow(item, index) {
  const busy = item.status === 'uploading' || item.status === 'submitting';
  const notes = state.snap?.notes || {};
  const sub = el('div', { class: 'sub' }, itemTag(item.status));
  if (item.status === 'queued' && state.term) {
    const p = priorityOf(target, state.term, item);
    if (p.deadline) sub.append(el('span', { class: 'tag', 'data-tone': 'strong', text: t('prioDeadline', [p.deadline.slice(5, 10)]) }));
    if (p.revision) sub.append(el('span', { class: 'tag', 'data-tone': 'strong', text: t('prioRevision') }));
    if (p.optional) sub.append(el('span', { class: 'tag', 'data-tone': 'faint', text: t('prioOptional') }));
  }
  if (item.status === 'queued' && notes[item.id]) sub.append(t(notes[item.id]));
  if (item.status === 'pending') sub.append(queueText(item.queuePosition, item.estimatedWaitMinutes));

  const reasonShown = ['blocked', 'failed'].includes(item.status) || (item.status === 'queued' && item.reason);
  const actions = el('div', { class: 'row-actions' });
  if (['blocked', 'failed'].includes(item.status)) {
    actions.append(el('button', { type: 'button', text: t('retry'), onclick: () => retry(item) }));
  }
  if (['queued', 'needs_revision', 'blocked', 'failed'].includes(item.status)) {
    actions.append(el('button', { type: 'button', text: t('replaceImage'), onclick: () => pickReplacement(item.id) }));
  }

  const links = el('div', { class: 'links' });
  for (const [i, url] of (item.reviewFileUrls || []).entries()) {
    links.append(el('a', { href: url, target: '_blank', rel: 'noreferrer' }, t('reviewImage', [String(i + 1)]), icon('external')));
  }

  const li = el('li', {
    class: 'row', 'data-id': item.id, tabindex: '0', draggable: busy ? null : 'true',
    'aria-label': `${item.title}, ${itemStatusText(item.status)}`,
    onkeydown: (e) => {
      if (e.target !== li) return;
      if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(item.id, -1); }
      if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(item.id, 1); }
      if (e.key === 'Delete' && !busy) { e.preventDefault(); remove(item); }
    },
  },
  el('span', { class: 'grip', 'aria-hidden': 'true' }, icon('grip')),
  thumbFor(item),
  el('div', { class: 'main' },
    el('div', { class: 'title', text: item.title }),
    sub,
    reasonShown ? el('div', { class: 'reason', text: reasonText(item.reason, item.reasonDetail) }) : null,
    item.status === 'needs_revision' && item.teacherFeedback ? el('div', { class: 'feedback', text: item.teacherFeedback }) : null,
    links.childElementCount ? links : null,
    actions.childElementCount ? actions : null),
  el('div', { class: 'tools' },
    el('button', { class: 'icon', type: 'button', title: t('moveUp'), 'aria-label': t('moveUp'), disabled: index === 0, onclick: () => move(item.id, -1) }, icon('up')),
    el('button', { class: 'icon', type: 'button', title: t('moveDown'), 'aria-label': t('moveDown'), disabled: index === state.backlog.length - 1, onclick: () => move(item.id, 1) }, icon('down')),
    el('button', { class: 'icon', type: 'button', title: t(item.status === 'pending' ? 'stopTracking' : 'remove'), 'aria-label': t('removeItem', [item.title]), disabled: busy, onclick: () => remove(item) }, icon('x'))));

  wireDrag(li, item.id);
  return li;
}

let dragId = null;
function wireDrag(li, id) {
  li.addEventListener('dragstart', (e) => { dragId = id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); });
  li.addEventListener('dragend', () => { dragId = null; li.classList.remove('dragging'); clearDropMarks(); });
  li.addEventListener('dragover', (e) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const after = e.offsetY > li.offsetHeight / 2;
    clearDropMarks();
    li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('drop', async (e) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const after = li.classList.contains('drop-after');
    clearDropMarks();
    const ids = state.backlog.map((i) => i.id).filter((x) => x !== dragId);
    ids.splice(ids.indexOf(id) + (after ? 1 : 0), 0, dragId);
    await store.reorder(ids);
    await itemsChanged();
  });
}
function clearDropMarks() {
  for (const n of document.querySelectorAll('.drop-before, .drop-after')) n.classList.remove('drop-before', 'drop-after');
}

async function remove(item) {
  await store.removeItem(item.id);
  await itemsChanged();
}

async function retry(item) {
  // Retrying is the user's decision to send this drawing anyway, so take the node's
  // current round count as the new baseline for the submitted-elsewhere check.
  const a = state.term ? findAssignment(state.term, item.assignmentId) : null;
  const roundsAtQueue = a ? nodeSubmissions(a, item.nodeId).length : null;
  await store.patchItem(item.id, { status: 'queued', reason: null, reasonDetail: null, attempts: 0, nextAttemptAt: null, roundsAtQueue }, ['blocked', 'failed']);
  await itemsChanged();
}

function pickReplacement(id) {
  state.replaceId = id;
  $('replaceFile').value = '';
  $('replaceFile').click();
}

function renderBacklog() {
  gcThumbs();
  const list = $('backlogList');
  const focused = document.activeElement?.closest?.('li.row')?.dataset.id;
  list.replaceChildren(...state.backlog.map(itemRow));
  if (focused) list.querySelector(`li.row[data-id="${focused}"]`)?.focus();
  $('backlogEmpty').hidden = state.backlog.length > 0;
  $('clearDone').hidden = !state.backlog.some((i) => i.status === 'done');

  // In review: server truth, including rounds submitted outside the extension.
  const pend = state.snap?.pending || [];
  $('reviewList').replaceChildren(...pend.map((p) => el('li', { class: 'row' },
    el('div', { class: 'main' },
      el('div', { class: 'title', text: p.label }),
      el('div', { class: 'sub' }, nodeTag(p.status, false), queueText(p.queuePosition, p.estimatedWaitMinutes))))));
  $('reviewEmpty').hidden = pend.length > 0;
}

// ---------------------------------------------------------------------------
// Add: image

function validateImage(file) {
  if (!file) return 'errNoImage';
  if (!file.type.startsWith('image/')) return 'errNotImage';
  if (file.size === 0) return 'errEmptyFile';
  if (file.size > target.maxUploadBytes) return 'errTooLarge';
  return null;
}

let previewUrl = null;
function setImage(file) {
  const err = validateImage(file);
  if (err) { showAddError(t(err)); return; }
  state.image = { blob: file, name: file.name || `paste-${Date.now()}.${(file.type.split('/')[1] || 'png')}` };
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  $('preview').src = previewUrl;
  $('preview').hidden = false;
  $('dropText').hidden = true;
  $('fileInfo').textContent = t('fileInfo', [state.image.name, (file.size / 1024 / 1024).toFixed(2)]);
  showAddError('');
  updateAddButton();
}

function clearImage() {
  state.image = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('preview').hidden = true;
  $('dropText').hidden = false;
  $('fileInfo').textContent = '';
}

function firstImage(dt) {
  return [...(dt?.files || [])].find((f) => f.type.startsWith('image/')) || dt?.files?.[0] || null;
}

// ---------------------------------------------------------------------------
// Add: node picker

function matches(q, ...texts) {
  if (!q) return true;
  return texts.some((s) => s && String(s).toLowerCase().includes(q));
}

function renderPicker() {
  const box = $('picker');
  if (!state.term) {
    box.replaceChildren(el('div', { class: 'muted none', text: t(state.treeError ? 'pickerUnavailable' : 'loading') }));
    return;
  }
  const q = $('search').value.trim().toLowerCase();
  const showAll = $('showAll').checked;
  const groups = [];

  for (const { lesson, assignment: a } of listAssignments(state.term)) {
    const nodes = (a.nodes || []).length ? a.nodes : [null];
    const rows = [];
    let anySelectable = false;
    for (const n of nodes) {
      const status = nodeStatus(a, n);
      if (!showAll && status === target.doneStatus) continue;
      if (!matches(q, a.title, n?.title, lesson?.title, lesson?.groupTitle)) continue;
      const ps = pickState(a, n);
      if (ps.ok) anySelectable = true;
      const nodeId = n ? String(n.nodeId) : null;
      const sel = state.selected?.assignmentId === String(a.assignmentId) && state.selected?.nodeId === nodeId;
      const hint = ps.ok ? (ps.chained ? t('chainedHint') : '') : reasonText(ps.reason, ps.detail);
      const input = el('input', {
        type: 'radio', name: 'node', value: `${a.assignmentId}|${nodeId ?? ''}`, disabled: !ps.ok, checked: sel,
        onchange: () => { state.selected = { assignmentId: String(a.assignmentId), nodeId }; showAddError(''); updateAddButton(); markSelected(); },
      });
      rows.push(el('label', { class: `node${ps.ok ? '' : ' disabled'}${sel ? ' selected' : ''}`, title: hint || null, 'data-key': `${a.assignmentId}|${nodeId ?? ''}` },
        input,
        el('span', { class: 'node-title', text: n ? n.title || `#${n.nodeOrder}` : t('wholeAssignment') }),
        ps.chained ? el('span', { class: 'tag', 'data-tone': 'faint', text: t('chained') }) : nodeTag(status, n?.locked)));
    }
    // By default, hide assignments where nothing can be queued right now (closed,
    // prerequisite missing, every open node locked or already queued), like approved nodes.
    if (!rows.length || (!showAll && !anySelectable)) continue;
    const note = a.blockedReason ? String(a.blockedReason) : a.status === 'CLOSED' ? t('reasonClosed') : null;
    groups.push(el('div', { class: 'group' },
      el('div', { class: 'group-head' },
        el('span', { class: 'group-title', text: a.title }),
        el('span', { class: 'tag', text: t(TYPE_KEYS[a.assignmentType] || 'typeOther') })),
      note ? el('div', { class: 'group-note', text: note }) : null,
      rows));
  }
  box.replaceChildren(...(groups.length ? groups : [el('div', { class: 'muted none', text: t('noMatches') })]));
}

function markSelected() {
  for (const n of document.querySelectorAll('.node.selected')) n.classList.remove('selected');
  if (!state.selected) return;
  document.querySelector(`.node[data-key="${state.selected.assignmentId}|${state.selected.nodeId ?? ''}"]`)?.classList.add('selected');
}

function updateAddButton() {
  $('addBtn').disabled = !(state.image && state.selected && state.term);
}

function showAddError(msg) {
  $('addError').textContent = msg;
}

async function addItem() {
  const sel = state.selected;
  const imgErr = validateImage(state.image?.blob);
  if (imgErr) return showAddError(t(imgErr));
  if (!sel) return showAddError(t('errNoNode'));
  // Re-check eligibility client-side; a locked or otherwise unsubmittable node is
  // rejected here with no network call.
  const a = findAssignment(state.term, sel.assignmentId);
  const n = sel.nodeId ? findNode(a, sel.nodeId) : null;
  const ps = a ? pickState(a, n) : { ok: false, reason: 'reasonAssignmentMissing' };
  if (!ps.ok) return showAddError(reasonText(ps.reason, ps.detail));

  const title = label(a, n);
  $('addBtn').disabled = true;
  // enqueue() replaces an earlier item for this node that came back or got stuck.
  await store.enqueue({
    blob: state.image.blob, name: state.image.name, assignmentId: sel.assignmentId, nodeId: sel.nodeId, title,
    roundsAtQueue: nodeSubmissions(a, sel.nodeId).length,
  });
  await chrome.storage.local.set({ 'chamber:lastPick': { assignmentId: sel.assignmentId, nodeId: sel.nodeId, label: title } });
  clearImage();
  state.selected = null;
  await itemsChanged();
  $('drop').focus();
}

// ---------------------------------------------------------------------------
// Audit

async function renderAudit() {
  const log = (await getAudit()).slice(-60).reverse();
  const titles = new Map(state.backlog.map((i) => [i.id, i.title]));
  $('auditList').replaceChildren(...log.map((e) => el('li', {},
    el('span', { text: new Date(e.at).toLocaleString() }),
    el('span', { text: [e.action, titles.get(e.itemId), e.method, e.result, e.message].filter(Boolean).join(' · ') }))));
}

// ---------------------------------------------------------------------------

async function refresh({ tree = false } = {}) {
  await Promise.all([loadLocal(), loadTree(tree), loadLogin()]);
  // Show the backlog in the order the scheduler will actually use.
  if (state.term) state.backlog = prioritize(target, state.term, state.backlog).map((r) => r.item);
  renderHeader();
  renderBacklog();
  renderPicker();
  updateAddButton();
  if ($('auditList').closest('details').open) renderAudit();
}

function applyPrefill() {
  const q = new URLSearchParams(location.search);
  const a = q.get('a');
  if (!a || !state.term) return;
  const assignment = findAssignment(state.term, a);
  if (!assignment) return;
  $('search').value = assignment.title;
  const n = q.get('n');
  const node = n ? findNode(assignment, n) : (assignment.nodes || []).find((x) => pickState(assignment, x).ok);
  if (node && pickState(assignment, node).ok) state.selected = { assignmentId: String(assignment.assignmentId), nodeId: String(node.nodeId) };
  // Opened from an assignment where nothing can be queued: show it anyway, with the reasons.
  else $('showAll').checked = true;
  renderPicker();
  document.querySelector('.node.selected')?.scrollIntoView({ block: 'nearest' });
  history.replaceState(null, '', location.pathname);
}

// ---------------------------------------------------------------------------
// Automatic login. The page never receives the saved password.

// Set once the user edits the form; background refreshes then leave the fields alone
// until Save or Forget, so a periodic update cannot wipe what is being typed.
let loginDirty = false;

function renderLogin(st) {
  if (!st) return;
  if (!loginDirty) {
    $('loginEnabled').checked = st.enabled;
    $('loginAccount').value = st.account;
  }
  $('loginPassword').placeholder = t(st.hasPassword ? 'loginPasswordSaved' : 'loginPassword');
  $('loginForget').hidden = !st.account && !st.hasPassword;
  let text = t('autoLoginOff');
  let error = false;
  if (st.enabled && !st.hasPassword) text = t('autoLoginNeedCreds');
  else if (st.enabled && st.error) { text = t(st.rejected ? 'autoLoginRejected' : 'autoLoginFailed', [st.error]); error = true; }
  else if (st.enabled && st.ok) text = t('autoLoginOk', [new Date(st.at).toLocaleString()]);
  else if (st.enabled) text = t('autoLoginReady');
  $('loginStatus').textContent = text;
  $('loginStatus').classList.toggle('accent', error);
  $('loginStatus').classList.toggle('muted', !error);
}

async function loadLogin() {
  renderLogin(await send('chamber:loginStatus'));
}

function wire() {
  $('loginForm').addEventListener('input', () => { loginDirty = true; });
  $('loginForm').addEventListener('change', () => { loginDirty = true; });
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginSave').disabled = true;
    $('loginStatus').textContent = t('autoLoginSaving');
    try {
      renderLogin(await send('chamber:saveLogin', {
        enabled: $('loginEnabled').checked, account: $('loginAccount').value, password: $('loginPassword').value,
      }));
    } finally {
      $('loginPassword').value = '';
      $('loginSave').disabled = false;
      loginDirty = false;
      loadLogin();
    }
  });
  $('loginForget').addEventListener('click', async () => {
    $('loginPassword').value = '';
    $('loginAccount').value = '';
    loginDirty = false;
    renderLogin(await send('chamber:forgetLogin'));
  });

  for (const opt of $('tickSeconds').options) opt.textContent = t('seconds', [opt.value]);

  $('pauseBtn').addEventListener('click', () => send('chamber:settings', { patch: { paused: !state.settings.paused } }));
  $('autoSubmit').addEventListener('change', (e) => send('chamber:settings', { patch: { autoSubmit: e.target.checked } }));
  $('dryRun').addEventListener('change', (e) => send('chamber:settings', { patch: { dryRun: e.target.checked } }));
  $('tickSeconds').addEventListener('change', (e) => send('chamber:settings', { patch: { tickSeconds: Number(e.target.value) } }));
  $('locale').addEventListener('change', async (e) => {
    await send('chamber:settings', { patch: { locale: e.target.value } });
    location.reload();
  });
  $('runOnce').addEventListener('click', async () => {
    $('runOnce').disabled = true;
    try { await send('chamber:tick', { manual: true }); } finally { await refresh({ tree: true }); }
  });
  $('bannerAction').addEventListener('click', openSite);
  $('clearDone').addEventListener('click', async () => {
    for (const i of state.backlog.filter((x) => x.status === 'done')) await store.removeItem(i.id);
    await itemsChanged();
  });

  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  drop.addEventListener('dragover', (e) => { if (dragId) return; e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { if (dragId) return; e.preventDefault(); drop.classList.remove('over'); setImage(firstImage(e.dataTransfer)); });
  $('file').addEventListener('change', (e) => setImage(e.target.files[0]));
  document.addEventListener('paste', (e) => {
    const f = firstImage(e.clipboardData);
    if (f) { e.preventDefault(); setImage(f); }
  });
  $('replaceFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    const err = validateImage(f);
    if (err) { showAddError(t(err)); return; }
    const cur = state.backlog.find((i) => i.id === state.replaceId);
    const a = cur && state.term ? findAssignment(state.term, cur.assignmentId) : null;
    if (cur) await store.replaceImage(cur.id, f, f.name, a ? nodeSubmissions(a, cur.nodeId).length : null);
    state.replaceId = null;
    await itemsChanged();
  });

  $('search').addEventListener('input', renderPicker);
  $('showAll').addEventListener('change', renderPicker);
  $('addBtn').addEventListener('click', addItem);
  $('auditList').closest('details').addEventListener('toggle', (e) => { if (e.target.open) renderAudit(); });
  window.addEventListener('focus', () => refresh({ tree: true }));
  onChanged(() => refresh());
}

await initI18n();
applyI18n();
wire();
await refresh({ tree: true });
applyPrefill();
