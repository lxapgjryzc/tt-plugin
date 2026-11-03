// Pure: given a state snapshot and the backlog, decide what (if anything) to do this tick.
// No chrome.*, no fetch, no timers.
//
// Output:
//   { action: 'idle', why, notes, pending, limit }
//   { action: 'submit', item, method, why, notes, pending, limit }
// `notes` maps queued item id -> reason key explaining why it is waiting.
// `blocks` lists queued items that can never go through without user action.
// `order` lists item ids in priority order; `prio` maps id -> its priority facts.

import {
  countPending, findAssignment, findNode, isSubmittable, nodeSubmissions, latestSubmission, parseServerTime, nodeStatus,
} from './model.js';

const ACTIVE = new Set(['uploading', 'submitting', 'pending']);
// Feasibility failures that will clear up by themselves; the item keeps waiting.
const TRANSIENT = new Set(['reasonLocked', 'reasonPendingOnNode']);
// Not a block either: reconcile marks queued items on approved nodes as skipped.
const LEFT_TO_RECONCILE = new Set(['reasonApproved']);

export function byOrder(a, b) {
  return (a.order ?? 0) - (b.order ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt));
}

/**
 * What makes an item urgent, read from the server tree:
 *   deadline  the assignment has an explicit deadline (earliest first)
 *   revision  the node's latest round came back for changes; it blocks every later node
 *   optional  the assignment is not required
 */
export function priorityOf(target, term, item) {
  const a = term ? findAssignment(term, item.assignmentId) : null;
  const dl = a?.deadline ? parseServerTime(a.deadline) : NaN;
  const latest = a ? latestSubmission(a, item.nodeId) : null;
  return {
    deadline: Number.isFinite(dl) ? a.deadline : null,
    deadlineMs: Number.isFinite(dl) ? dl : Infinity,
    revision: !!latest && target.needsRevisionStatuses.includes(latest.status),
    optional: a?.isRequired === false,
  };
}

// Earliest deadline, then revisions, then required before optional, then the user's order.
export function prioritize(target, term, items) {
  return items
    .map((item) => ({ item, p: priorityOf(target, term, item) }))
    .sort((x, y) => (x.p.deadlineMs - y.p.deadlineMs)
      || (Number(y.p.revision) - Number(x.p.revision))
      || (Number(x.p.optional) - Number(y.p.optional))
      || byOrder(x.item, y.item));
}

export function schedule({ target, term, backlog, settings, now = Date.now(), manual = false }) {
  const notes = {};
  const blocks = [];
  const base = { notes, blocks, pending: null, limit: null };

  if (settings.paused) return { ...base, action: 'idle', why: 'paused' };
  if (settings.sessionInvalid) return { ...base, action: 'idle', why: 'sessionInvalid' };
  if (!term) return { ...base, action: 'idle', why: 'noTerm' };

  const limit = Number(term.maxPendingSubmissions);
  const pending = countPending(target, term);
  base.pending = pending;
  base.limit = Number.isFinite(limit) ? limit : null;

  const ranked = prioritize(target, term, backlog);
  const items = ranked.map((r) => r.item);
  base.order = items.map((i) => i.id);
  base.prio = Object.fromEntries(ranked.map(({ item, p }) => [item.id, { deadline: p.deadline, revision: p.revision, optional: p.optional }]));
  if (items.some((i) => i.status === 'uploading' || i.status === 'submitting')) {
    return { ...base, action: 'idle', why: 'inFlight' };
  }

  // Nodes already occupied by one of our items.
  const busyNodes = new Set(
    items.filter((i) => ACTIVE.has(i.status)).map((i) => `${i.assignmentId}|${i.nodeId}`),
  );
  const claimed = new Set();
  let pick = null;

  for (const item of items) {
    if (item.status !== 'queued') continue;
    const key = `${item.assignmentId}|${item.nodeId}`;
    if (busyNodes.has(key) || claimed.has(key)) {
      notes[item.id] = 'waitSameNode';
      continue;
    }
    claimed.add(key);
    if (item.nextAttemptAt && item.nextAttemptAt > now) {
      notes[item.id] = 'waitBackoff';
      continue;
    }
    const assignment = findAssignment(term, item.assignmentId);
    const feas = isSubmittable(target, term, assignment, item.nodeId, now);
    if (!feas.ok) {
      if (LEFT_TO_RECONCILE.has(feas.reason)) continue;
      if (TRANSIENT.has(feas.reason)) notes[item.id] = feas.reason === 'reasonLocked' ? 'waitLocked' : 'waitNodePending';
      else blocks.push({ id: item.id, reason: feas.reason, detail: feas.detail ?? null });
      continue;
    }
    if (!pick) pick = { item, assignment };
    else notes[item.id] = 'waitTurn';
  }

  if (!pick) return { ...base, action: 'idle', why: items.some((i) => i.status === 'queued') ? 'nothingEligible' : 'empty' };
  if (!Number.isFinite(limit) || pending >= limit) {
    notes[pick.item.id] = 'waitSlot';
    return { ...base, action: 'idle', why: 'atLimit', next: pick.item };
  }
  if (!settings.autoSubmit && !manual) {
    notes[pick.item.id] = 'waitAutoOff';
    return { ...base, action: 'idle', why: 'autoOff', next: pick.item };
  }

  const node = findNode(pick.assignment, pick.item.nodeId);
  const rounds = nodeSubmissions(pick.assignment, node ? node.nodeId : null).length;
  return {
    ...base,
    action: 'submit',
    why: 'ok',
    item: pick.item,
    next: pick.item,
    method: rounds === 0 ? 'POST' : 'PUT',
    roundsBefore: rounds,
  };
}

/**
 * Final guard run right before the write request, against a freshly re-read tree.
 * Returns null if it is safe to send, otherwise a reason key.
 */
export function preflight({ target, term, item, roundsBefore }) {
  if (!term) return 'noTerm';
  const limit = Number(term.maxPendingSubmissions);
  if (!Number.isFinite(limit) || countPending(target, term) >= limit) return 'atLimit';
  const assignment = findAssignment(term, item.assignmentId);
  const feas = isSubmittable(target, term, assignment, item.nodeId);
  if (!feas.ok) return feas.reason;
  if (nodeSubmissions(assignment, item.nodeId).length !== roundsBefore) return 'reasonNodeChanged';
  return null;
}

// Backoff for retryable upload failures: 800 ms doubling, capped at 60 s, full jitter.
export const MAX_ATTEMPTS = 6;
export function backoffMs(attempts, rand = Math.random) {
  const ceil = Math.min(60_000, 800 * 2 ** Math.max(0, attempts - 1));
  return Math.max(800, Math.round(ceil * rand()));
}

/**
 * Can the user queue a drawing for this node right now? Client-side only, no network.
 * Returns { ok, reason?, detail?, chained?, followUp? }.
 *
 * followUp: the node has a round in review or items of ours still to go out; the new
 *   item is sent after those, once the node's round comes back returned (requirements R2).
 * chained:  the node is locked, but the node before it is queued here or under review;
 *   the item waits until that node is approved.
 */
export function canQueue(target, term, backlog, assignment, node) {
  if (!assignment) return { ok: false, reason: 'reasonAssignmentMissing' };
  const aid = String(assignment.assignmentId);
  const nodeId = node ? String(node.nodeId) : null;
  const ours = (nid) => backlog.some((i) => i.assignmentId === aid && i.nodeId === nid && ACTIVE_OR_QUEUED.has(i.status));

  const feas = isSubmittable(target, term, assignment, nodeId);
  const followUp = ours(nodeId) || target.pendingStatuses.includes(nodeStatus(assignment, node));
  const extra = followUp ? { followUp: true } : {};
  if (feas.ok || feas.reason === 'reasonPendingOnNode') return { ok: true, ...extra };
  if (feas.reason !== 'reasonLocked') return { ok: false, reason: feas.reason, detail: feas.detail };

  const prev = (assignment.nodes || []).find((n) => n.nodeOrder === node.nodeOrder - 1);
  if (!prev) return { ok: false, reason: 'reasonLocked' };
  const prevPending = target.pendingStatuses.includes(nodeStatus(assignment, prev));
  if (ours(String(prev.nodeId)) || prevPending) return { ok: true, chained: true, ...extra };
  return { ok: false, reason: 'reasonLockedNoChain' };
}

const ACTIVE_OR_QUEUED = new Set(['queued', 'uploading', 'submitting', 'pending']);

// Items the user should look at (toolbar badge count). A returned item stops counting
// once a follow-up for its node is queued or out (requirements R2.4).
export function needsAttention(backlog) {
  const followed = new Set(backlog.filter((i) => ACTIVE_OR_QUEUED.has(i.status)).map((i) => `${i.assignmentId}|${i.nodeId}`));
  return backlog.filter((i) => ['blocked', 'failed'].includes(i.status)
    || (i.status === 'needs_revision' && !followed.has(`${i.assignmentId}|${i.nodeId}`)));
}
