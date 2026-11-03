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

// Every file key a round carries. A multi-image round is sent as one comma-joined
// `fileUrl`, so keys containing commas are split as well.
export function fileKeys(sub) {
  const keys = new Set();
  for (const v of [sub?.fileObjectName, sub?.fileUrl, ...(sub?.fileObjectNames || []), ...(sub?.fileUrls || [])]) {
    if (!v) continue;
    for (const part of String(v).split(',')) if (part.trim()) keys.add(part.trim());
  }
  return [...keys];
}

// Does this server round carry any of the files we uploaded? Object names are matched
// exactly or as the path suffix of a full URL. `objectNames` is a name or a list.
export function submissionHasFile(sub, objectNames) {
  const names = [].concat(objectNames ?? []).filter(Boolean).map((n) => String(n).replace(/^\/+/, ''));
  if (!names.length) return false;
  return fileKeys(sub).some((k) => names.some((name) => {
    if (k === name) return true;
    try {
      return decodeURIComponent(new URL(k).pathname).replace(/^\/+/, '').endsWith(name);
    } catch {
      return false;
    }
  }));
}

export function findSubmissionByFile(assignment, nodeId, objectNames) {
  const subs = nodeSubmissions(assignment, nodeId);
  for (let i = subs.length - 1; i >= 0; i--) if (submissionHasFile(subs[i], objectNames)) return subs[i];
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

// The type label the site shows for an assignment (e.g. in its submit dialog).
const TYPE_LABELS = {
  BASIC: '基础作业', ADVANCED: '进阶作业', EXTENDED: '扩展作业', BI_WEEKLY: '双周作业', GRADUATION: '毕业设计', DRILL: '团练打卡',
};
const STAGE_LABELS = { 1: '阶段一', 2: '阶段二', 3: '阶段三' };
export function siteTypeLabel(assignment) {
  if (assignment?.assignmentType === 'GRADUATION') {
    const stage = STAGE_LABELS[assignment.stageNo];
    return stage ? `毕设${stage}` : '毕业设计';
  }
  return TYPE_LABELS[assignment?.assignmentType] || assignment?.assignmentType || '';
}

/**
 * Resolve the node named by the site's submit dialog, which only shows chapter title,
 * type label and node title. `catalog` is GET /student/courses/terms/{id}/catalog.
 * Returns { assignmentId, nodeId } or { error } with a message key. Never guesses:
 * anything but exactly one match is an error.
 */
export function resolveDialogNode(catalog, { chapterTitle, typeLabel, nodeTitle }) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const chapters = (catalog?.chapters || []).filter((c) => norm(c.groupTitle) === norm(chapterTitle));
  const assignments = chapters.flatMap((c) => c.assignments || []).filter((a) => norm(siteTypeLabel(a)) === norm(typeLabel));
  const hits = [];
  for (const a of assignments) {
    const nodes = a.nodes || [];
    if (!nodes.length) {
      if (!norm(nodeTitle)) hits.push({ assignmentId: sid(a.assignmentId), nodeId: null });
      continue;
    }
    for (const n of nodes) if (norm(n.title) === norm(nodeTitle)) hits.push({ assignmentId: sid(a.assignmentId), nodeId: sid(n.nodeId) });
  }
  if (hits.length === 1) return hits[0];
  if (norm(nodeTitle) === FINAL_STEP_TITLE && !hits.length) return { error: 'reasonFinalSubmission' };
  return { error: hits.length ? 'reasonAmbiguousNode' : 'reasonNodeMissing' };
}

// Links into the site (requirements R4). The assignment page has no URL parameter for
// the node, so the extension's own links carry it in a fragment that the content script
// reads to select that node. Keep NODE_FRAGMENT in sync with content/homework-badge.js.
export const NODE_FRAGMENT = 'chamber-node';

export function siteNodeUrl(target, assignmentId, nodeId) {
  const url = `${target.base}/student/assignment/${encodeURIComponent(assignmentId)}`;
  return nodeId == null ? url : `${url}#${NODE_FRAGMENT}=${encodeURIComponent(nodeId)}`;
}

export function siteLearningUrl(target, termId, assignmentId) {
  const url = `${target.base}/student/learning${termId ? `/${encodeURIComponent(termId)}` : ''}`;
  return assignmentId ? `${url}?assignmentId=${encodeURIComponent(assignmentId)}` : url;
}

// Title of the extra step the site shows after every node is approved.
export const FINAL_STEP_TITLE = '完整作业';

// Assignments whose nodes are all approved but whose 完整作业 has not been submitted.
// Graduation projects have no such step; closed assignments are left out.
export function finalSubmissionsDue(term, now = Date.now()) {
  if (!termIsActive(term)) return [];
  return listAssignments(term)
    .map(({ assignment }) => assignment)
    .filter((a) => a.assignmentType !== 'GRADUATION'
      && (a.nodes || []).length > 0
      && a.nodes.every((n) => n.status === 'APPROVED')
      && !a.finalSubmission
      && !assignmentExpired(a, term.endDate, now));
}
