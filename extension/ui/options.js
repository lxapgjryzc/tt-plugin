import {
  t, initI18n, applyI18n, send, el, icon, itemTag, itemStatusText, nodeTag, TYPE_KEYS, reasonText, queueText, relTime, renderPips, onChanged, openSite, why,
} from './common.js';
import * as store from '../src/storage/idb.js';
import { KEYS, getSettings, getAudit } from '../src/storage/settings.js';
import { target } from '../src/target.js';
import {
  listAssignments, findAssignment, findNode, nodeStatus, nodeSubmissions, label, finalSubmissionsDue, siteNodeUrl, siteLearningUrl,
} from '../src/model.js';
import { prioritize, priorityOf, canQueue } from '../src/scheduler.js';
import { imageProblem, imageSetProblem } from '../src/images.js';
import { NODE_STATES, nodeState, defaultFilter, normalizeFilter, typeOf } from '../src/picker.js';
import { parseReviewHours } from '../src/review-hours.js';

const $ = (id) => document.getElementById(id);
const TREE_TTL = 30_000;

const state = {
  term: null,
  treeAt: 0,
  treeError: null,
  backlog: [],
  settings: null,
  snap: null,
  images: [], // [{ blob, name, url }] in submission order, at most target.maxImagesPerSubmission
  selected: null, // { assignmentId, nodeId }
  thumbs: new Map(), // imageId -> object URL
  replaceId: null,
  filter: null, // picker filter (R7), loaded in wire()
  focusAssignment: null, // assignment shown regardless of the filter (opened from the site)
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
  $('reviewHoursOn').checked = settings.reviewHoursOn;
  if (document.activeElement !== $('reviewHours')) $('reviewHours').value = settings.reviewHours;
  $('reviewHours').disabled = !settings.reviewHoursOn;
  $('reviewHoursLocal').textContent = localReviewHours(settings.reviewHours);
  const hint = settings.paused ? 'hintPaused' : settings.dryRun ? 'hintDryRun' : settings.autoSubmit ? 'hintAuto' : 'hintManual';
  $('modeHint').textContent = t(hint);
  $('runOnce').disabled = settings.paused;
}

// ---------------------------------------------------------------------------
// Backlog

// The first image of the item's set, with a count when there are more.
function thumbFor(item) {
  const first = item.imageIds?.[0];
  const count = item.imageIds?.length || 0;
  const wrap = el('div', { class: 'thumb-wrap' },
    count > 1 ? el('span', { class: 'thumb-count', 'aria-label': t('imageCount', [String(count)]), text: `+${count - 1}` }) : null);
  const url = state.thumbs.get(first);
  if (url) {
    wrap.prepend(el('img', { class: 'thumb', src: url, alt: '' }));
    return wrap;
  }
  const ph = el('div', { class: 'thumb ph' }, icon('image'));
  wrap.prepend(ph);
  if (first) {
    store.getImage(first).then((img) => {
      if (!img?.blob) return;
      const u = URL.createObjectURL(img.blob);
      state.thumbs.set(first, u);
      ph.replaceWith(el('img', { class: 'thumb', src: u, alt: '' }));
    });
  }
  return wrap;
}

function gcThumbs() {
  const live = new Set(state.backlog.map((i) => i.imageIds?.[0]));
  for (const [id, url] of state.thumbs) if (!live.has(id)) { URL.revokeObjectURL(url); state.thumbs.delete(id); }
}

async function itemsChanged() {
  await send('chamber:itemsChanged');
  await refresh();
}

// Ids of the backlog list in the order shown (R5.1); reordering only acts on these.
const queueIds = () => state.backlog.filter((i) => IN_BACKLOG.has(i.status)).map((i) => i.id);

async function move(id, delta) {
  const ids = queueIds();
  const at = ids.indexOf(id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(at, 1)[0]);
  await store.reorder(ids);
  await itemsChanged();
  document.querySelector(`li.row[data-id="${id}"]`)?.focus();
}

function itemRow(item, index, list) {
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

  if (item.status === 'needs_revision' && followedUp(item)) sub.append(t('followUpQueued'));

  const reasonShown = ['blocked', 'failed', 'skipped'].includes(item.status) || (item.status === 'queued' && item.reason);
  const actions = el('div', { class: 'row-actions' });
  if (['blocked', 'failed'].includes(item.status)) {
    actions.append(el('button', { type: 'button', text: t('retry'), onclick: () => retry(item) }));
  }
  if (['queued', 'needs_revision', 'blocked', 'failed'].includes(item.status)) {
    actions.append(el('button', { type: 'button', text: t('replaceImages'), onclick: () => pickReplacement(item.id) }));
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
    siteLink(siteNodeUrl(target, item.assignmentId, item.nodeId), item.title),
    sub,
    reasonShown ? el('div', { class: 'reason', text: reasonText(item.reason, item.reasonDetail) }) : null,
    ['needs_revision', 'continued'].includes(item.status) && item.teacherFeedback ? el('div', { class: 'feedback', text: item.teacherFeedback }) : null,
    links.childElementCount ? links : null,
    actions.childElementCount ? actions : null),
  el('div', { class: 'tools' },
    el('button', { class: 'icon', type: 'button', title: t('moveUp'), 'aria-label': t('moveUp'), disabled: index === 0, onclick: () => move(item.id, -1) }, icon('up')),
    el('button', { class: 'icon', type: 'button', title: t('moveDown'), 'aria-label': t('moveDown'), disabled: index === list.length - 1, onclick: () => move(item.id, 1) }, icon('down')),
    el('button', { class: 'icon', type: 'button', title: t('remove'), 'aria-label': t('removeItem', [item.title]), disabled: busy, onclick: () => remove(item) }, icon('x'))));

  wireDrag(li, item.id);
  return li;
}

// A returned item whose node already has a later item of ours waiting or out.
function followedUp(item) {
  return state.backlog.some((i) => i !== item && i.assignmentId === item.assignmentId && i.nodeId === item.nodeId
    && ['queued', 'uploading', 'submitting', 'pending'].includes(i.status));
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
    const ids = queueIds().filter((x) => x !== dragId);
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

// Sections of the queue page (requirements R5). Items keep being stored after they are
// sent; only where they are shown depends on their status.
const IN_BACKLOG = new Set(['queued', 'uploading', 'submitting', 'blocked', 'failed', 'needs_revision']);
const WAITING = new Set(['queued', 'uploading', 'submitting']);
const nodeKey = (x) => `${x.assignmentId}|${x.nodeId ?? null}`;

function renderBacklog() {
  gcThumbs();
  const list = $('backlogList');
  const focused = document.activeElement?.closest?.('li.row')?.dataset.id;
  const queue = state.backlog.filter((i) => IN_BACKLOG.has(i.status));
  list.replaceChildren(...queue.map((item, i) => itemRow(item, i, queue)));
  if (focused) list.querySelector(`li.row[data-id="${focused}"]`)?.focus();
  $('backlogEmpty').hidden = queue.length > 0;

  renderReview();

  const finished = state.backlog.filter((i) => FINISHED.has(i.status));
  $('finished').hidden = !finished.length;
  $('finishedCount').textContent = String(finished.length);
  $('finishedList').replaceChildren(...finished.map((item) => compactRow(item, {
    sub: [itemTag(item.status)],
    reason: ['skipped', 'withdrawn'].includes(item.status) ? reasonText(item.reason) : null,
    feedback: item.teacherFeedback,
    removeTitle: t('remove'),
  })));

  // 完整作业 not submitted yet: a reminder only, the extension never submits it (R3).
  const due = state.term ? finalSubmissionsDue(state.term) : [];
  $('finalDue').hidden = !due.length;
  $('finalList').replaceChildren(...due.map((a) => el('li', { class: 'row' },
    el('div', { class: 'main' },
      siteLink(siteLearningUrl(target, state.term.termId, a.assignmentId), a.title),
      el('div', { class: 'sub' }, el('span', { class: 'tag', text: t(TYPE_KEYS[a.assignmentType] || 'typeOther') }))))));
}

// A node or assignment name that opens it on the site in a new tab (requirements R4).
function siteLink(href, text) {
  return el('a', { class: 'title site-link', href, target: '_blank', rel: 'noreferrer', title: t('openOnSite'), text });
}

// In review (R5.2): every pending round on the platform, with our own item's images and
// follow-ups when the extension sent it. Our pending items the last check has not
// reported yet are listed as well.
function renderReview() {
  const pend = state.snap?.pending || [];
  const ours = new Map(state.backlog.filter((i) => i.status === 'pending').map((i) => [nodeKey(i), i]));
  const rows = pend.map((p) => {
    const item = ours.get(nodeKey(p));
    ours.delete(nodeKey(p));
    return { p, item };
  });
  for (const item of ours.values()) rows.push({ p: null, item });

  $('reviewList').replaceChildren(...rows.map(({ p, item }) => {
    const status = p?.status ?? item.serverStatus;
    const queuePosition = p?.queuePosition ?? item?.queuePosition;
    const sub = [nodeTag(status, false), queueText(queuePosition, p?.estimatedWaitMinutes ?? item?.estimatedWaitMinutes)];
    const behind = state.backlog.filter((i) => WAITING.has(i.status) && nodeKey(i) === nodeKey(p ?? item)).length;
    if (behind) sub.push(el('span', { class: 'tag', 'data-tone': 'faint', text: t('followUpsBehind', [String(behind)]) }));
    // Only a round no TA has opened yet can be withdrawn (R6.1).
    const round = {
      assignmentId: p?.assignmentId ?? item.assignmentId, nodeId: p ? p.nodeId : item.nodeId,
      submissionId: p?.submissionId ?? item?.submissionId, label: p?.label ?? item.title, queuePosition, behind,
    };
    const actions = status === 'SUBMITTED' && round.submissionId ? el('div', { class: 'row-actions' },
      el('button', { type: 'button', text: t('withdraw'), onclick: () => askWithdraw(round, null) }),
      el('button', { type: 'button', text: t('withdrawReplace'), onclick: () => pickWithdrawReplacement(round) })) : null;
    if (item) return compactRow(item, { title: p?.label, sub, actions, removeTitle: t('stopTracking') });
    return el('li', { class: 'row' },
      el('div', { class: 'main' },
        p.assignmentId ? siteLink(siteNodeUrl(target, p.assignmentId, p.nodeId), p.label) : el('div', { class: 'title', text: p.label }),
        el('div', { class: 'sub' }, ...sub),
        actions));
  }));
  $('reviewEmpty').hidden = rows.length > 0;
}

// A row for an item outside the backlog: no reordering, only removal.
function compactRow(item, { title, sub = [], reason = null, feedback = null, actions = null, removeTitle }) {
  return el('li', { class: 'row', 'data-id': item.id },
    thumbFor(item),
    el('div', { class: 'main' },
      siteLink(siteNodeUrl(target, item.assignmentId, item.nodeId), title || item.title),
      el('div', { class: 'sub' }, ...sub),
      reason ? el('div', { class: 'reason', text: reason }) : null,
      feedback ? el('div', { class: 'feedback', text: feedback }) : null,
      actions),
    el('div', { class: 'tools' },
      el('button', { class: 'icon', type: 'button', title: removeTitle, 'aria-label': t('removeItem', [item.title]), onclick: () => remove(item) }, icon('x'))));
}

// Items that are over: removed by "Clear finished".
const FINISHED = new Set(['done', 'continued', 'skipped', 'withdrawn']);

// ---------------------------------------------------------------------------
// Withdraw (requirements R6). Replacement images are picked and checked first, so
// cancelling the file dialog never withdraws anything; then the user confirms the exact
// round in a dialog; the service worker re-checks it before deleting.

let withdrawing = null; // { round, files }

function pickWithdrawReplacement(round) {
  withdrawing = { round, files: null };
  $('withdrawFile').value = '';
  $('withdrawFile').click();
}

function askWithdraw(round, files) {
  withdrawing = { round, files };
  const d = $('withdrawDialog');
  $('wdBody').textContent = t('withdrawBody', [round.label]);
  $('wdQueue').textContent = round.queuePosition ? t('withdrawQueueLoss', [String(round.queuePosition)]) : t('withdrawQueueLossNoPos');
  $('wdNext').textContent = files ? t('withdrawReplaceNote') : round.behind ? t('withdrawFollowUps', [String(round.behind)]) : '';
  $('wdNext').hidden = !$('wdNext').textContent;
  for (const img of $('wdPreviews').querySelectorAll('img')) URL.revokeObjectURL(img.src);
  $('wdPreviews').replaceChildren(...(files || []).map((f, i) => el('div', { class: 'preview' },
    el('img', { src: URL.createObjectURL(f), alt: t('imageN', [String(i + 1)]) }))));
  $('wdPreviews').hidden = !files;
  $('wdError').textContent = '';
  $('wdConfirm').hidden = false;
  $('wdConfirm').disabled = false;
  $('wdCancel').textContent = t('cancel');
  d.showModal();
}

async function confirmWithdraw() {
  const { round, files } = withdrawing || {};
  if (!round) return;
  $('wdConfirm').disabled = true;
  $('wdError').textContent = t('withdrawing');
  let replacement = null;
  if (files) {
    const a = state.term ? findAssignment(state.term, round.assignmentId) : null;
    const n = a && round.nodeId ? findNode(a, round.nodeId) : null;
    replacement = {
      imageIds: await store.stageImages(files.map((f) => ({ blob: f, name: fileName(f) }))),
      title: a ? label(a, n) : round.label,
    };
  }
  // The service worker discards staged images itself if it refuses.
  const res = await send('chamber:withdraw', {
    assignmentId: round.assignmentId, nodeId: round.nodeId, submissionId: round.submissionId, replacement,
  });
  if (res?.ok) {
    $('withdrawDialog').close();
    withdrawing = null;
    await refresh({ tree: true });
    return;
  }
  showWithdrawError(reasonText(res?.reason || 'reasonServerRejected', res?.detail));
  await refresh({ tree: true });
}

function showWithdrawError(text) {
  $('wdError').textContent = text;
  $('wdConfirm').hidden = true;
  $('wdCancel').textContent = t('close');
}

// ---------------------------------------------------------------------------
// Add: image

const MAX_IMAGES = target.maxImagesPerSubmission;
const fileName = (file) => file.name || `paste-${Date.now()}.${(file.type.split('/')[1] || 'png')}`;

// Add files to the pending set. Invalid files are refused with a message; files past
// the limit are refused too, never silently dropped (requirements R1.2).
function addImages(files) {
  files = [...(files || [])];
  if (!files.length) return;
  const bad = files.map((f) => imageProblem(target, f)).find(Boolean);
  if (bad) { showAddError(t(bad)); return; }
  if (state.images.length + files.length > MAX_IMAGES) {
    showAddError(t('errTooManyImages'));
    return;
  }
  for (const f of files) state.images.push({ blob: f, name: fileName(f), url: URL.createObjectURL(f) });
  showAddError('');
  renderImages();
}

function removeImage(index) {
  const [gone] = state.images.splice(index, 1);
  if (gone) URL.revokeObjectURL(gone.url);
  renderImages();
}

function clearImages() {
  for (const img of state.images) URL.revokeObjectURL(img.url);
  state.images = [];
  renderImages();
}

function renderImages() {
  const has = state.images.length > 0;
  $('previews').hidden = !has;
  $('dropText').hidden = has;
  $('previews').replaceChildren(...state.images.map((img, i) => el('div', { class: 'preview' },
    el('img', { src: img.url, alt: t('imageN', [String(i + 1)]) }),
    el('button', {
      class: 'icon remove-image', type: 'button', title: t('removeImage'), 'aria-label': t('removeImage'),
      onclick: (e) => { e.stopPropagation(); removeImage(i); },
    }, icon('x')))));
  const mb = state.images.reduce((n, i) => n + i.blob.size, 0) / 1024 / 1024;
  $('fileInfo').textContent = has ? t('imagesInfo', [String(state.images.length), String(MAX_IMAGES), mb.toFixed(2)]) : '';
  updateAddButton();
}

const imageFiles = (dt) => [...(dt?.files || [])];

// ---------------------------------------------------------------------------
// Add: node picker

// ---- filters (requirements R7) ----
// The list is built once per data change (buildPicker); filters and search only show or
// hide what is there (applyPickerFilter), so a click never rebuilds anything (R7.6).
// The filter is remembered per browser as a convenience; any failure means the defaults.
const FILTER_KEY = 'chamber.pickerFilter';
const STATE_KEYS = {
  canQueue: 'filterCanQueue', queued: 'filterQueued', inReview: 'filterInReview',
  returned: 'filterReturned', approved: 'filterApproved', unavailable: 'filterUnavailable',
};

function loadFilter() {
  try { return normalizeFilter(JSON.parse(localStorage.getItem(FILTER_KEY) || 'null')); } catch { return defaultFilter(); }
}

function saveFilter() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(state.filter)); } catch { /* not remembered */ }
}

// A user change to the filter: remember it and drop the one-off view from a site link.
function changeFilter(fn) {
  fn(state.filter);
  state.focusAssignment = null;
  saveFilter();
  applyPickerFilter();
}

const toggle = (list, value) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

// Built picker: { entries: [{ a, type, state, text, row }], groups: [{ el, entries }], chips }.
let picker = null;

function chip(text, onclick) {
  const count = el('span', { class: 'chip-count' });
  const button = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick }, text, count);
  return { button, count };
}

function nodeRow(a, n, ps, status) {
  const key = String(a.assignmentId);
  const nodeId = n ? String(n.nodeId) : null;
  const sel = state.selected?.assignmentId === key && state.selected?.nodeId === nodeId;
  const hint = ps.ok ? [ps.chained ? t('chainedHint') : '', ps.followUp ? t('followUpHint') : ''].filter(Boolean).join(' ') : reasonText(ps.reason, ps.detail);
  const input = el('input', {
    type: 'radio', name: 'node', value: `${key}|${nodeId ?? ''}`, disabled: !ps.ok, checked: sel,
    onchange: () => { state.selected = { assignmentId: key, nodeId }; showAddError(''); updateAddButton(); markSelected(); },
  });
  return el('label', { class: `node${ps.ok ? '' : ' disabled'}${sel ? ' selected' : ''}`, title: hint || null, 'data-key': `${key}|${nodeId ?? ''}` },
    input,
    el('span', { class: 'node-title', text: n ? n.title || `#${n.nodeOrder}` : t('wholeAssignment') }),
    ps.followUp ? el('span', { class: 'tag', 'data-tone': 'faint', text: t('followUp') })
      : ps.chained ? el('span', { class: 'tag', 'data-tone': 'faint', text: t('chained') }) : nodeTag(status, n?.locked));
}

// Rebuild rows and chips from the current data. Called on data changes only.
function buildPicker() {
  const box = $('picker');
  if (!state.term) {
    picker = null;
    box.replaceChildren(el('div', { class: 'muted none', text: t(state.treeError ? 'pickerUnavailable' : 'loading') }));
    return;
  }
  const scrollTop = box.scrollTop;
  const entries = [];
  const groups = [];
  const types = [];
  for (const { lesson, assignment: a } of listAssignments(state.term)) {
    const type = typeOf(a);
    if (!types.includes(type)) types.push(type);
    const group = { entries: [] };
    for (const n of (a.nodes || []).length ? a.nodes : [null]) {
      const { state: st, verdict, status } = nodeState(target, state.term, state.backlog, a, n);
      const text = [a.title, n?.title, lesson?.title, lesson?.groupTitle].filter(Boolean).join('\n').toLowerCase();
      const entry = { a, type, state: st, text, row: nodeRow(a, n, verdict, status) };
      entries.push(entry);
      group.entries.push(entry);
    }
    const note = a.blockedReason ? String(a.blockedReason) : a.status === 'CLOSED' ? t('reasonClosed') : null;
    group.el = el('div', { class: 'group' },
      el('div', { class: 'group-head' },
        el('span', { class: 'group-title', text: a.title }),
        el('span', { class: 'tag', text: t(TYPE_KEYS[a.assignmentType] || 'typeOther') })),
      note ? el('div', { class: 'group-note', text: note }) : null,
      group.entries.map((e) => e.row));
    groups.push(group);
  }
  const none = el('div', { class: 'muted none', text: t('noMatches') });
  box.replaceChildren(...groups.map((g) => g.el), none);

  const chips = {
    states: Object.fromEntries(NODE_STATES.map((s) => [s, chip(t(STATE_KEYS[s]), () => changeFilter((f) => { f.states = toggle(f.states, s); }))])),
    types: Object.fromEntries(types.map((type) => [type, chip(t(TYPE_KEYS[type] || 'typeOther'), () => changeFilter((f) => { f.hiddenTypes = toggle(f.hiddenTypes, type); }))])),
  };
  $('filterStateChips').replaceChildren(...Object.values(chips.states).map((c) => c.button));
  $('filterTypeChips').replaceChildren(...Object.values(chips.types).map((c) => c.button));
  picker = { entries, groups, chips, none };
  applyPickerFilter();
  box.scrollTop = scrollTop;
}

// Show or hide rows for the current filter and search; update chips in place.
function applyPickerFilter() {
  if (!picker) return;
  const q = $('search').value.trim().toLowerCase();
  const shownStates = new Set(state.filter.states);
  const hiddenTypes = new Set(state.filter.hiddenTypes);
  const stateCounts = {};
  const typeCounts = {};
  for (const e of picker.entries) {
    const found = !q || e.text.includes(q);
    const typeOk = !hiddenTypes.has(e.type);
    const stateOk = shownStates.has(e.state);
    if (found && typeOk) stateCounts[e.state] = (stateCounts[e.state] || 0) + 1;
    if (found && stateOk) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    // Opened from the site for one assignment: show all of it, whatever the filter (R7.5).
    const forced = state.focusAssignment === String(e.a.assignmentId);
    e.row.hidden = !(found && (forced || (typeOk && stateOk)));
  }
  let any = false;
  for (const g of picker.groups) {
    g.el.hidden = g.entries.every((e) => e.row.hidden);
    any ||= !g.el.hidden;
  }
  picker.none.hidden = any;

  for (const [s, c] of Object.entries(picker.chips.states)) {
    c.button.setAttribute('aria-pressed', String(shownStates.has(s)));
    c.count.textContent = String(stateCounts[s] || 0);
  }
  for (const [type, c] of Object.entries(picker.chips.types)) {
    c.button.setAttribute('aria-pressed', String(!hiddenTypes.has(type)));
    c.count.textContent = String(typeCounts[type] || 0);
  }
  const isDefault = JSON.stringify(state.filter) === JSON.stringify(defaultFilter());
  $('resetFilter').hidden = isDefault && !state.focusAssignment;
}

const renderPicker = buildPicker;

function markSelected() {
  for (const n of document.querySelectorAll('.node.selected')) n.classList.remove('selected');
  if (!state.selected) return;
  document.querySelector(`.node[data-key="${state.selected.assignmentId}|${state.selected.nodeId ?? ''}"]`)?.classList.add('selected');
}

function updateAddButton() {
  $('addBtn').disabled = !(state.images.length && state.selected && state.term);
}

function showAddError(msg) {
  $('addError').textContent = msg;
}

async function addItem() {
  const sel = state.selected;
  const imgErr = imageSetProblem(target, state.images.map((i) => i.blob));
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
  // enqueue() replaces an item for this node that got stuck; otherwise the new item
  // goes after any earlier ones on the node as a follow-up.
  await store.enqueue({
    images: state.images.map(({ blob, name }) => ({ blob, name })), assignmentId: sel.assignmentId, nodeId: sel.nodeId, title,
    roundsAtQueue: nodeSubmissions(a, sel.nodeId).length,
  });
  await chrome.storage.local.set({ 'chamber:lastPick': { assignmentId: sel.assignmentId, nodeId: sel.nodeId, label: title } });
  clearImages();
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
  // Show this assignment whatever the remembered filter says (R7.5).
  state.focusAssignment = String(assignment.assignmentId);
  renderPicker();
  document.querySelector('.node.selected')?.scrollIntoView({ block: 'nearest' });
  history.replaceState(null, '', location.pathname);
}

// Review hours are in Beijing time; show them in the user's own time as well.
function localReviewHours(text) {
  const windows = parseReviewHours(text);
  if (!windows || new Date().getTimezoneOffset() === -480) return '';
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); // today in Beijing
  const at = (min) => new Date(Date.parse(`${day}T00:00:00+08:00`) + min * 60_000)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return t('reviewHoursLocal', [windows.map(([s, e]) => `${at(s)}–${at(e)}`).join(', ')]);
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
  state.filter = loadFilter();
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
  $('reviewHoursOn').addEventListener('change', (e) => send('chamber:settings', { patch: { reviewHoursOn: e.target.checked } }));
  $('reviewHours').addEventListener('change', (e) => {
    const text = e.target.value.trim();
    if (!parseReviewHours(text)) {
      $('reviewHoursError').textContent = t('reviewHoursInvalid');
      return;
    }
    $('reviewHoursError').textContent = '';
    send('chamber:settings', { patch: { reviewHours: text } });
  });
  $('locale').addEventListener('change', async (e) => {
    await send('chamber:settings', { patch: { locale: e.target.value } });
    location.reload();
  });
  $('runOnce').addEventListener('click', async () => {
    $('runOnce').disabled = true;
    try { await send('chamber:tick', { manual: true }); } finally { await refresh({ tree: true }); }
  });
  $('bannerAction').addEventListener('click', openSite);
  $('finalOpen').addEventListener('click', () => {
    chrome.tabs.create({ url: siteLearningUrl(target, state.term?.termId) });
  });
  $('clearDone').addEventListener('click', async (e) => {
    e.preventDefault(); // it sits in the section's <summary>; do not toggle it
    for (const i of state.backlog.filter((x) => FINISHED.has(x.status))) await store.removeItem(i.id);
    await itemsChanged();
  });

  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  drop.addEventListener('dragover', (e) => { if (dragId) return; e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { if (dragId) return; e.preventDefault(); drop.classList.remove('over'); addImages(imageFiles(e.dataTransfer)); });
  $('file').addEventListener('change', (e) => { addImages(e.target.files); e.target.value = ''; });
  // Paste appends, like the site's own dialog.
  document.addEventListener('paste', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    const files = imageFiles(e.clipboardData);
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  $('replaceFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    const err = imageSetProblem(target, files);
    if (err) { showAddError(t(err)); return; }
    const cur = state.backlog.find((i) => i.id === state.replaceId);
    const a = cur && state.term ? findAssignment(state.term, cur.assignmentId) : null;
    if (cur) {
      await store.replaceImages(cur.id, files.map((f) => ({ blob: f, name: fileName(f) })), a ? nodeSubmissions(a, cur.nodeId).length : null);
    }
    state.replaceId = null;
    await itemsChanged();
  });

  $('withdrawFile').addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (!files.length || !withdrawing) return;
    const err = imageSetProblem(target, files);
    askWithdraw(withdrawing.round, err ? null : files);
    if (err) showWithdrawError(t(err)); // nothing is withdrawn with a bad image set
  });
  $('wdConfirm').addEventListener('click', confirmWithdraw);
  $('wdCancel').addEventListener('click', () => $('withdrawDialog').close());

  $('search').addEventListener('input', applyPickerFilter);
  $('resetFilter').addEventListener('click', () => changeFilter((f) => Object.assign(f, defaultFilter())));
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
