// Pure: diff the local backlog against the server's term tree.
// Returns a list of { id, patch } to apply. Never decides to submit anything.
//
// Called at the start of every tick while holding the tick lock, so any item found in
// `uploading` or `submitting` belongs to a tick that died (the app was killed,
// network timeout). Those are resolved from server state, never from local belief.

import {
  findAssignment,
  findNode,
  nodeSubmissions,
  nodeStatus,
  findSubmissionByFile,
  submissionHasFile,
  reviewFiles,
} from './model.js';

// Final states. continued: returned, then a later item of ours went out on the same node.
// skipped: never sent because the node was approved first. withdrawn: its round was
// deleted from the platform (by Chamber on request, or on the site).
const TERMINAL = new Set(['done', 'failed', 'continued', 'skipped', 'withdrawn']);

/**
 * Ids of the rounds on this node that our own items made: those carrying files we
 * uploaded, plus the in-doubt round of an item still `submitting` (the round at index
 * roundsBefore, which trackedRound also adopts). Anything else was submitted elsewhere.
 */
function ownRoundIds(backlog, assignment, nodeId) {
  const subs = nodeSubmissions(assignment, nodeId);
  const aid = String(assignment.assignmentId);
  const own = new Set();
  for (const it of backlog) {
    if (it.assignmentId !== aid || it.nodeId !== nodeId) continue;
    for (const s of subs) if (submissionHasFile(s, it.objectNames)) own.add(String(s.submissionId));
    if (it.status === 'submitting' && Number.isInteger(it.roundsBefore) && subs[it.roundsBefore]) {
      own.add(String(subs[it.roundsBefore].submissionId));
    }
  }
  return own;
}

function trackedRound(item, assignment) {
  const subs = nodeSubmissions(assignment, item.nodeId);
  if (item.submissionId) {
    const byId = subs.find((s) => String(s.submissionId) === String(item.submissionId));
    if (byId) return byId;
  }
  if (item.objectNames?.length) {
    const byFile = findSubmissionByFile(assignment, item.nodeId, item.objectNames);
    if (byFile) return byFile;
  }
  // A new round appeared on this node since we started submitting. Even if the file
  // key does not match, it must be treated as ours: resubmitting would burn a round.
  // Only while we do not know our round yet: once we do, a different round at that
  // index means ours was withdrawn and someone else submitted.
  if (!item.submissionId && Number.isInteger(item.roundsBefore) && subs.length > item.roundsBefore) return subs[item.roundsBefore];
  return null;
}

function patchFromRound(target, item, sub) {
  const base = {
    submissionId: String(sub.submissionId),
    serverStatus: sub.status,
    queuePosition: sub.queuePosition ?? null,
    estimatedWaitMinutes: sub.estimatedWaitMinutes ?? null,
  };
  if (target.pendingStatuses.includes(sub.status)) return { ...base, status: 'pending', reason: null };
  if (sub.status === target.doneStatus) {
    return { ...base, status: 'done', reason: null, teacherFeedback: sub.teacherFeedback ?? null, reviewFileUrls: reviewFiles(sub) };
  }
  if (target.needsRevisionStatuses.includes(sub.status)) {
    return {
      ...base,
      status: 'needs_revision',
      reason: null,
      teacherFeedback: sub.teacherFeedback ?? null,
      reviewFileUrls: reviewFiles(sub),
      reviewedAt: sub.reviewedAt ?? null,
      reviewedByName: sub.reviewedByName ?? null,
    };
  }
  return { ...base, status: 'pending', reason: null };
}

function changed(item, patch) {
  for (const [k, v] of Object.entries(patch)) {
    const cur = item[k];
    if (Array.isArray(v) ? JSON.stringify(v) !== JSON.stringify(cur ?? []) : cur !== v) return true;
  }
  return false;
}

export function reconcile({ target, term, backlog }) {
  const out = [];
  const push = (item, patch) => {
    if (changed(item, patch)) out.push({ id: item.id, patch });
  };

  for (const item of backlog) {
    if (TERMINAL.has(item.status)) continue;
    const assignment = findAssignment(term, item.assignmentId);
    if (!assignment) {
      if (item.status !== 'blocked') push(item, { status: 'blocked', reason: 'reasonAssignmentMissing' });
      continue;
    }
    const node = item.nodeId === null ? null : findNode(assignment, item.nodeId);

    switch (item.status) {
      case 'pending': {
        const sub = trackedRound(item, assignment);
        if (sub) push(item, patchFromRound(target, item, sub));
        else if (nodeStatus(assignment, node) === target.doneStatus) push(item, { status: 'done', reason: null });
        // Our round is gone: withdrawn on the site, or a withdrawal whose response was
        // lost. Nothing is left to wait for (R6.6).
        else if (item.submissionId) push(item, { status: 'withdrawn', reason: 'reasonWithdrawnElsewhere' });
        break;
      }
      case 'submitting': {
        // In doubt: the request may or may not have reached the server.
        const sub = trackedRound(item, assignment);
        if (sub) push(item, patchFromRound(target, item, sub));
        else if (target.pendingStatuses.includes(nodeStatus(assignment, node))) {
          // Someone else (the user, in the SPA) has a pending round on this node now.
          push(item, { status: 'blocked', reason: 'reasonNodeChanged' });
        } else {
          // No new round exists: the request never landed. Safe to queue again; the
          // uploaded objectNames are kept and reused.
          push(item, { status: 'queued', reason: 'reasonInterrupted', roundsBefore: null });
        }
        break;
      }
      case 'uploading':
        push(item, { status: 'queued', reason: 'reasonInterrupted' });
        break;
      case 'queued': {
        // Picked up by the SPA or a previous tick we lost track of?
        const sub = item.objectNames?.length ? findSubmissionByFile(assignment, item.nodeId, item.objectNames) : null;
        if (sub) {
          push(item, patchFromRound(target, item, sub));
          break;
        }
        // Approved before this item went out (the TA approved directly, or the student
        // stopped there). Nothing can be sent to an approved node: retire the item
        // instead of leaving it to block or wait (requirements R2.3).
        if (nodeStatus(assignment, node) === target.doneStatus) {
          push(item, { status: 'skipped', reason: 'reasonApprovedBeforeSent' });
          break;
        }
        if (!Number.isInteger(item.roundsAtQueue)) break;
        // Rounds added since this item was queued: our own items' rounds just move the
        // baseline on (follow-ups, R2.5); any other round was submitted outside
        // Chamber (e.g. the site's own button), and sending ours too would burn another
        // round, so stop and let the user decide. Withdrawn rounds lower the baseline, so
        // the next outside round is still noticed (R6.7).
        const subs = nodeSubmissions(assignment, item.nodeId);
        const own = ownRoundIds(backlog, assignment, item.nodeId);
        let base = Math.min(item.roundsAtQueue, subs.length);
        while (base < subs.length && own.has(String(subs[base].submissionId))) base++;
        if (base < subs.length) push(item, { status: 'blocked', reason: 'reasonSubmittedElsewhere' });
        else if (base !== item.roundsAtQueue) push(item, { roundsAtQueue: base });
        break;
      }
      case 'needs_revision': {
        const subs = nodeSubmissions(assignment, item.nodeId);
        const at = item.submissionId ? subs.findIndex((s) => String(s.submissionId) === String(item.submissionId)) : -1;
        if (at >= 0) {
          // A later item of ours went out on this node: this round has been followed up.
          const own = ownRoundIds(backlog, assignment, item.nodeId);
          if (subs.slice(at + 1).some((s) => own.has(String(s.submissionId)))) {
            push(item, { status: 'continued', reason: null });
          } else {
            // Waits for the user, but the user may resubmit on the site itself. Follow the
            // latest round from the returned one on, so a resubmission shows as pending and
            // its approval as done instead of the item staying "returned" forever.
            push(item, patchFromRound(target, item, subs[subs.length - 1]));
          }
        } else if (nodeStatus(assignment, node) === target.doneStatus) push(item, { status: 'done', reason: null });
        break;
      }
      default:
        // blocked waits for the user.
        break;
    }
  }
  return out;
}
