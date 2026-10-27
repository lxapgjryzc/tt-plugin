// Pure helpers over the term tree returned by GET /student/courses/terms/{id}/weeks.
// IDs are always compared as strings.

export const sid = (v) => (v === null || v === undefined ? null : String(v));

export function selectTerm(courses) {
  if (!Array.isArray(courses) || courses.length === 0) return null;
  const started = courses.filter((c) => c.termStatus === 'STARTED');
  return started.length === 1 ? started[0] : started[0] || courses[0];
}

// Flat list of assignments with their lesson/week context, in tree order.
export function listAssignments(term) {
  const out = [];
  for (const week of term?.weeks || []) {
    for (const lesson of week.lessons || []) {
      for (const a of lesson.assignments || []) out.push({ week, lesson, assignment: a });
    }
  }
  return out;
}

export function findAssignment(term, assignmentId) {
  const id = sid(assignmentId);
  return listAssignments(term).find((x) => sid(x.assignment.assignmentId) === id)?.assignment || null;
}

export function findNode(assignment, nodeId) {
  if (!assignment) return null;
  const id = sid(nodeId);
  return (assignment.nodes || []).find((n) => sid(n.nodeId) === id) || null;
}

// Rounds for a node in chronological order. nodeId null = node-less homework.
export function nodeSubmissions(assignment, nodeId) {
  const id = sid(nodeId);
  return (assignment?.submissions || []).filter((s) => sid(s.nodeId) === id);
}

export function latestSubmission(assignment, nodeId) {
  const subs = nodeSubmissions(assignment, nodeId);
  return subs.length ? subs[subs.length - 1] : null;
}

// Current status for a node: node.status mirrors the latest round; fall back to it.
export function nodeStatus(assignment, node) {
  if (node) return node.status ?? latestSubmission(assignment, node.nodeId)?.status ?? null;
  return latestSubmission(assignment, null)?.status ?? null;
}

// All pending submissions across the term, counted per (assignment, node) latest round.
// This is a superset of the SPA's own count (last round per assignment), so it never
// under-counts.
export function pendingSubmissions(target, term) {
  const out = [];
  for (const { assignment } of listAssignments(term)) {
    const byNode = new Map();
    for (const s of assignment.submissions || []) byNode.set(sid(s.nodeId), s);
    for (const s of byNode.values()) {
      if (target.pendingStatuses.includes(s.status)) out.push({ assignment, submission: s });
    }
  }
  return out;
}

export function countPending(target, term) {
  return pendingSubmissions(target, term).length;
}

export function fileKeys(sub) {
  const keys = new Set();
  for (const v of [sub?.fileObjectName, sub?.fileUrl, ...(sub?.fileObjectNames || []), ...(sub?.fileUrls || [])]) {
    if (v) keys.add(String(v));
  }
  return [...keys];
}

// Does this server round carry the file we uploaded? Object names are matched exactly or
// as the path suffix of a full URL.
export function submissionHasFile(sub, objectName) {
  if (!objectName) return false;
  const name = String(objectName).replace(/^\/+/, '');
  return fileKeys(sub).some((k) => {
    if (k === name) return true;
    try {
      return decodeURIComponent(new URL(k).pathname).replace(/^\/+/, '').endsWith(name);
    } catch {
      return false;
    }
  });
}

export function findSubmissionByFile(assignment, nodeId, objectName) {
  const subs = nodeSubmissions(assignment, nodeId);
  for (let i = subs.length - 1; i >= 0; i--) if (submissionHasFile(subs[i], objectName)) return subs[i];
  return null;
}

export function reviewFiles(sub) {
  if (!sub) return [];
  if (Array.isArray(sub.reviewFileUrls) && sub.reviewFileUrls.length) return sub.reviewFileUrls;
  return sub.reviewFileUrl ? [sub.reviewFileUrl] : [];
}

export function termIsActive(term) {
  if (!term) return false;
  if (['ARCHIVED'].includes(term.courseStatus)) return false;
  if (['FINISHED', 'CANCELLED'].includes(term.termStatus)) return false;
  return true;
}

// Server datetimes are naive Beijing-time strings ("2026-09-22T14:23:28"). Parse them
// as +08:00 regardless of the browser's timezone.
export function parseServerTime(s) {
  if (!s) return NaN;
  const str = String(s).trim().replace(' ', 'T');
  const naive = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(str);
  return new Date(naive ? `${str}+08:00` : str).getTime();
}

// Mirrors the SPA: closed, or past deadline (falling back to term end date).
export function assignmentExpired(assignment, termEndDate, now = Date.now()) {
  if (!assignment) return true;
  if (assignment.status === 'CLOSED') return true;
  const dl = assignment.deadline || (termEndDate ? `${termEndDate}T23:59:59` : null);
  if (!dl) return false;
  const t = parseServerTime(dl);
  return Number.isFinite(t) && t < now;
}

/**
 * Server-feasibility check: would the platform accept a submission for this node right now?
 * Not a scheduling decision. Returns { ok, reason } where reason is a message key.
 */
export function isSubmittable(target, term, assignment, nodeId, now = Date.now()) {
  if (!assignment) return { ok: false, reason: 'reasonAssignmentMissing' };
  if (!termIsActive(term)) return { ok: false, reason: 'reasonTermInactive' };
  if (assignmentExpired(assignment, term?.endDate, now)) return { ok: false, reason: 'reasonClosed' };
  if (assignment.blockedReason) return { ok: false, reason: 'reasonBlocked', detail: String(assignment.blockedReason) };
  const hasNodes = (assignment.nodes || []).length > 0;
  let node = null;
  if (hasNodes) {
    node = findNode(assignment, nodeId);
    if (!node) return { ok: false, reason: 'reasonNodeMissing' };
    if (node.locked) return { ok: false, reason: 'reasonLocked' };
  } else if (sid(nodeId) !== null) {
    return { ok: false, reason: 'reasonNodeMissing' };
  }
  const status = nodeStatus(assignment, node);
  if (status === target.doneStatus) return { ok: false, reason: 'reasonApproved' };
  if (target.pendingStatuses.includes(status)) return { ok: false, reason: 'reasonPendingOnNode' };
  return { ok: true, reason: null };
}

// Short label like "L7 形体优化 / 节点1" for an (assignment, node) pair.
export function label(assignment, node) {
  const a = assignment?.title || '?';
  return node ? `${a} / ${node.title || `#${node.nodeOrder}`}` : a;
}
