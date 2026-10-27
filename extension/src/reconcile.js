// Pure: diff the local backlog against the server's term tree.
// Returns a list of { id, patch } to apply. Never decides to submit anything.
//
// Called at the start of every tick while holding the tick lock, so any item found in
// `uploading` or `submitting` belongs to a tick that died (service worker eviction,
// network timeout). Those are resolved from server state, never from local belief.

import {
  findAssignment,
  findNode,
  nodeSubmissions,
  nodeStatus,
  findSubmissionByFile,
  reviewFiles,
} from './model.js';

const TERMINAL = new Set(['done', 'failed']);

function trackedRound(item, assignment) {
  const subs = nodeSubmissions(assignment, item.nodeId);
  if (item.submissionId) {
    const byId = subs.find((s) => String(s.submissionId) === String(item.submissionId));
    if (byId) return byId;
  }
  if (item.objectName) {
    const byFile = findSubmissionByFile(assignment, item.nodeId, item.objectName);
    if (byFile) return byFile;
  }
  // A new round appeared on this node since we started submitting. Even if the file
  // key does not match, it must be treated as ours: resubmitting would burn a round.
  if (Number.isInteger(item.roundsBefore) && subs.length > item.roundsBefore) return subs[item.roundsBefore];
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
          // uploaded objectName is kept and reused.
          push(item, { status: 'queued', reason: 'reasonInterrupted', roundsBefore: null });
        }
        break;
      }
      case 'uploading':
        push(item, { status: 'queued', reason: 'reasonInterrupted' });
        break;
      case 'queued': {
        // Picked up by the SPA or a previous tick we lost track of?
        const sub = item.objectName ? findSubmissionByFile(assignment, item.nodeId, item.objectName) : null;
        if (sub) push(item, patchFromRound(target, item, sub));
        else if (nodeStatus(assignment, node) === target.doneStatus) push(item, { status: 'blocked', reason: 'reasonApproved' });
        else if (Number.isInteger(item.roundsAtQueue) && nodeSubmissions(assignment, item.nodeId).length > item.roundsAtQueue) {
          // A round was submitted for this node outside the extension (e.g. the site's own
          // submit button) after this drawing was queued. Sending ours as well would burn
          // another round, so stop and let the user decide.
          push(item, { status: 'blocked', reason: 'reasonSubmittedElsewhere' });
        }
        break;
      }
      default:
        // needs_revision / blocked wait for the user.
        break;
    }
  }
  return out;
}
