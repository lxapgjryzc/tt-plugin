import { test } from 'node:test';
import assert from 'node:assert/strict';
import { target, makeTerm, ids, item, addRound, setStatus } from './fixtures.mjs';
import { countPending, isSubmittable, findAssignment, submissionHasFile, selectTerm } from '../extension/src/model.js';
import { schedule, preflight, backoffMs } from '../extension/src/scheduler.js';
import { reconcile } from '../extension/src/reconcile.js';

const S = { paused: false, autoSubmit: true, sessionInvalid: false };

test('ids stay strings and are never coerced', () => {
  const term = makeTerm();
  const a = findAssignment(term, ids.A1);
  assert.equal(a.assignmentId, ids.A1);
  assert.equal(findAssignment(term, Number(ids.A1)), null, 'a Number-coerced id must not match');
});

test('selectTerm prefers the single STARTED term', () => {
  assert.equal(selectTerm([{ termId: '1', termStatus: 'ENDED' }, { termId: '2', termStatus: 'STARTED' }]).termId, '2');
  assert.equal(selectTerm([]), null);
});

test('countPending counts SUBMITTED and REVIEWING across the term', () => {
  const term = makeTerm();
  assert.equal(countPending(target, term), 0);
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED');
  addRound(term, ids.A2, ids.A2n1, 'REVIEWING');
  assert.equal(countPending(target, term), 2);
  setStatus(term, ids.A2, ids.A2n1, 'REVIEWED');
  assert.equal(countPending(target, term), 1);
});

test('isSubmittable covers locked, closed, approved, pending, blocked', () => {
  const term = makeTerm();
  const A1 = findAssignment(term, ids.A1);
  assert.deepEqual(isSubmittable(target, term, A1, ids.A1n2), { ok: true, reason: null });
  assert.equal(isSubmittable(target, term, A1, ids.A1n3).reason, 'reasonLocked');
  assert.equal(isSubmittable(target, term, A1, '2000000000000000011').reason, 'reasonApproved');
  assert.equal(isSubmittable(target, term, A1, '1').reason, 'reasonNodeMissing');
  assert.equal(isSubmittable(target, term, findAssignment(term, ids.A3), ids.A3n1).reason, 'reasonClosed');
  A1.blockedReason = '请先完成';
  assert.equal(isSubmittable(target, term, A1, ids.A1n2).reason, 'reasonBlocked');
  A1.blockedReason = null;
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED');
  assert.equal(isSubmittable(target, term, A1, ids.A1n2).reason, 'reasonPendingOnNode');
  // returned for revision: feasible for the server (the scheduler still needs a new image)
  setStatus(term, ids.A1, ids.A1n2, 'REVIEWED');
  assert.equal(isSubmittable(target, term, A1, ids.A1n2).ok, true);
});

test('past deadline counts as closed', () => {
  const term = makeTerm();
  const A2 = findAssignment(term, ids.A2);
  A2.deadline = '2020-01-01T00:00:00';
  assert.equal(isSubmittable(target, term, A2, ids.A2n1).reason, 'reasonClosed');
});

test('submissionHasFile matches object names and full URLs', () => {
  const sub = { fileUrl: 'https://cdn.example/assignments/2026/a%20b.jpg', fileObjectNames: [] };
  assert.ok(submissionHasFile(sub, 'assignments/2026/a b.jpg'));
  assert.ok(!submissionHasFile(sub, 'assignments/2026/other.jpg'));
  assert.ok(submissionHasFile({ fileObjectName: 'assignments/x.jpg' }, 'assignments/x.jpg'));
});

test('two slots used, limit 2 -> no submission, reason atLimit', () => {
  const term = makeTerm({ limit: 2 });
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED');
  addRound(term, ids.A2, ids.A2n1, 'REVIEWING');
  const d = schedule({ target, term, backlog: [item({ assignmentId: ids.A2, nodeId: ids.A2n2 })], settings: S });
  assert.equal(d.action, 'idle');
  // A2n2 is locked, so nothing is eligible; use an eligible scenario too.
  const term2 = makeTerm({ limit: 2 });
  addRound(term2, ids.A2, ids.A2n1, 'SUBMITTED');
  addRound(term2, ids.A3, ids.A3n1, 'SUBMITTED');
  const it = item();
  const d2 = schedule({ target, term: term2, backlog: [it], settings: S });
  assert.equal(d2.action, 'idle');
  assert.equal(d2.why, 'atLimit');
  assert.equal(d2.notes[it.id], 'waitSlot');
});

test('limit 0 from the API blocks with no code change', () => {
  const term = makeTerm({ limit: 0 });
  const d = schedule({ target, term, backlog: [item()], settings: S });
  assert.equal(d.why, 'atLimit');
});

test('picks the first eligible item; locked nodes wait instead of failing', () => {
  const term = makeTerm();
  const locked = item({ assignmentId: ids.A1, nodeId: ids.A1n3 });
  const ok = item({ assignmentId: ids.A2, nodeId: ids.A2n1 });
  const d = schedule({ target, term, backlog: [locked, ok], settings: S });
  assert.equal(d.action, 'submit');
  assert.equal(d.item.id, ok.id);
  assert.equal(d.method, 'POST');
  assert.equal(d.notes[locked.id], 'waitLocked');
  assert.equal(d.blocks.length, 0);
});

test('closed assignment is blocked, not waited on', () => {
  const term = makeTerm();
  const it = item({ assignmentId: ids.A3, nodeId: ids.A3n1 });
  const d = schedule({ target, term, backlog: [it], settings: S });
  assert.deepEqual(d.blocks.map((b) => b.reason), ['reasonClosed']);
});

test('PUT when the node already has rounds', () => {
  const term = makeTerm();
  addRound(term, ids.A1, ids.A1n2, 'REVIEWED');
  const d = schedule({ target, term, backlog: [item()], settings: S });
  assert.equal(d.method, 'PUT');
  assert.equal(d.roundsBefore, 1);
});

test('one in flight at a time, and one item per node', () => {
  const term = makeTerm();
  const a = item({ status: 'submitting' });
  const b = item({ assignmentId: ids.A2, nodeId: ids.A2n1 });
  assert.equal(schedule({ target, term, backlog: [a, b], settings: S }).why, 'inFlight');
  const p = item({ status: 'pending' });
  const same = item();
  const d = schedule({ target, term, backlog: [p, same, b], settings: S });
  assert.equal(d.notes[same.id], 'waitSameNode');
  assert.equal(d.item.id, b.id);
});

test('paused, autoSubmit off, and manual override', () => {
  const term = makeTerm();
  const it = item();
  assert.equal(schedule({ target, term, backlog: [it], settings: { ...S, paused: true } }).why, 'paused');
  assert.equal(schedule({ target, term, backlog: [it], settings: { ...S, paused: true }, manual: true }).why, 'paused');
  assert.equal(schedule({ target, term, backlog: [it], settings: { ...S, autoSubmit: false } }).why, 'autoOff');
  assert.equal(schedule({ target, term, backlog: [it], settings: { ...S, autoSubmit: false }, manual: true }).action, 'submit');
});

test('needs_revision items are never picked', () => {
  const term = makeTerm();
  addRound(term, ids.A1, ids.A1n2, 'RETURNED');
  const d = schedule({ target, term, backlog: [item({ status: 'needs_revision' })], settings: S });
  assert.equal(d.action, 'idle');
});

test('preflight catches a round that appeared after the decision', () => {
  const term = makeTerm();
  const it = item();
  assert.equal(preflight({ target, term, item: it, roundsBefore: 0 }), null);
  addRound(term, ids.A1, ids.A1n2, 'REVIEWED');
  assert.equal(preflight({ target, term, item: it, roundsBefore: 0 }), 'reasonNodeChanged');
  setStatus(term, ids.A1, ids.A1n2, 'SUBMITTED');
  assert.equal(preflight({ target, term, item: it, roundsBefore: 1 }), 'reasonPendingOnNode');
});

test('backoff stays within 800 ms .. 60 s', () => {
  for (let n = 1; n <= 10; n++) {
    assert.ok(backoffMs(n, () => 1) <= 60_000);
    assert.ok(backoffMs(n, () => 0) >= 800);
  }
  assert.equal(backoffMs(20, () => 1), 60_000);
});

test('reconcile: pending -> needs_revision with feedback, -> done', () => {
  const term = makeTerm();
  const s = addRound(term, ids.A1, ids.A1n2, 'SUBMITTED', { fileObjectName: 'assignments/me.jpg' });
  const it = item({ status: 'pending', objectName: 'assignments/me.jpg' });
  let p = reconcile({ target, term, backlog: [it] });
  assert.equal(p[0].patch.status, 'pending');
  assert.equal(p[0].patch.submissionId, s.submissionId);
  setStatus(term, ids.A1, ids.A1n2, 'RETURNED', { teacherFeedback: '手臂再改', reviewFileUrls: ['r.jpg'] });
  p = reconcile({ target, term, backlog: [{ ...it, submissionId: s.submissionId }] });
  assert.equal(p[0].patch.status, 'needs_revision');
  assert.equal(p[0].patch.teacherFeedback, '手臂再改');
  assert.deepEqual(p[0].patch.reviewFileUrls, ['r.jpg']);
  setStatus(term, ids.A1, ids.A1n2, 'APPROVED');
  p = reconcile({ target, term, backlog: [{ ...it, submissionId: s.submissionId }] });
  assert.equal(p[0].patch.status, 'done');
});

test('reconcile: in-doubt submitting resolves from server state', () => {
  // landed, file matches
  let term = makeTerm();
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED', { fileObjectName: 'assignments/me.jpg' });
  let p = reconcile({ target, term, backlog: [item({ status: 'submitting', objectName: 'assignments/me.jpg', roundsBefore: 0 })] });
  assert.equal(p[0].patch.status, 'pending');
  // landed, file key unrecognisable: a new round still counts as ours
  term = makeTerm();
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED', { fileObjectName: 'weird' });
  p = reconcile({ target, term, backlog: [item({ status: 'submitting', objectName: 'assignments/me.jpg', roundsBefore: 0 })] });
  assert.equal(p[0].patch.status, 'pending');
  // never landed
  term = makeTerm();
  p = reconcile({ target, term, backlog: [item({ status: 'submitting', objectName: 'assignments/me.jpg', roundsBefore: 0 })] });
  assert.equal(p[0].patch.status, 'queued');
  // dead upload
  p = reconcile({ target, term, backlog: [item({ status: 'uploading' })] });
  assert.equal(p[0].patch.status, 'queued');
});

test('reconcile: queued item whose node got approved elsewhere is blocked', () => {
  const term = makeTerm();
  addRound(term, ids.A1, ids.A1n2, 'APPROVED');
  const p = reconcile({ target, term, backlog: [item()] });
  assert.equal(p[0].patch.status, 'blocked');
  assert.equal(p[0].patch.reason, 'reasonApproved');
});

test('reconcile is idempotent', () => {
  const term = makeTerm();
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED', { fileObjectName: 'f' });
  const it = item({ status: 'pending', objectName: 'f' });
  const [{ patch }] = reconcile({ target, term, backlog: [it] });
  assert.deepEqual(reconcile({ target, term, backlog: [{ ...it, ...patch }] }), []);
});

test('priority: earliest deadline, then revisions, then required, then user order', () => {
  const term = makeTerm({ limit: 2 });
  const [A1, A2, A3] = term.weeks[0].lessons[0].assignments;
  A3.status = 'PUBLISHED';
  A3.isRequired = false;
  addRound(term, ids.A1, ids.A1n2, 'REVIEWED');
  const plain = item({ assignmentId: ids.A2, nodeId: ids.A2n1, order: 1 });
  const optional = item({ assignmentId: ids.A3, nodeId: ids.A3n1, order: 2 });
  const revision = item({ assignmentId: ids.A1, nodeId: ids.A1n2, order: 3 });
  let d = schedule({ target, term, backlog: [plain, optional, revision], settings: S });
  assert.deepEqual(d.order, [revision.id, plain.id, optional.id]);
  assert.equal(d.item.id, revision.id, 'revision goes before plain work');
  assert.deepEqual(d.prio[revision.id], { deadline: null, revision: true, optional: false });
  assert.equal(d.prio[optional.id].optional, true);

  A2.deadline = '2099-01-01T00:00:00';
  A1.deadline = '2099-06-01T00:00:00';
  d = schedule({ target, term, backlog: [plain, optional, revision], settings: S });
  assert.deepEqual(d.order, [plain.id, revision.id, optional.id], 'earliest deadline first');
  assert.equal(d.item.id, plain.id);
});

test('priority does not let a waiting item jump the slot limit or a locked node', () => {
  const term = makeTerm({ limit: 1 });
  term.weeks[0].lessons[0].assignments[1].deadline = '2099-01-01T00:00:00';
  const locked = item({ assignmentId: ids.A2, nodeId: ids.A2n2, order: 1 });
  const ok = item({ order: 2 });
  const d = schedule({ target, term, backlog: [locked, ok], settings: S });
  assert.equal(d.order[0], locked.id);
  assert.equal(d.notes[locked.id], 'waitLocked');
  assert.equal(d.item.id, ok.id);
});

test('reconcile: a round submitted on the site after queueing blocks the queued item', () => {
  const term = makeTerm();
  addRound(term, ids.A1, ids.A1n2, 'REVIEWED');
  const it = item({ roundsAtQueue: 1 });
  assert.deepEqual(reconcile({ target, term, backlog: [it] }), [], 'nothing changed yet');
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED', { fileObjectName: 'assignments/site.jpg' });
  const [{ patch }] = reconcile({ target, term, backlog: [it] });
  assert.equal(patch.status, 'blocked');
  assert.equal(patch.reason, 'reasonSubmittedElsewhere');
  // legacy items without roundsAtQueue are left alone
  assert.deepEqual(reconcile({ target, term, backlog: [item()] }), []);
});

test('canQueue: duplicates, locks and chaining', async () => {
  const { canQueue } = await import('../extension/src/scheduler.js');
  const term = makeTerm();
  const A1 = findAssignment(term, ids.A1);
  const n2 = A1.nodes[1];
  const n3 = A1.nodes[2];
  assert.deepEqual(canQueue(target, term, [], A1, n2), { ok: true });
  assert.equal(canQueue(target, term, [item()], A1, n2).reason, 'reasonAlreadyQueued');
  assert.equal(canQueue(target, term, [], A1, n3).reason, 'reasonLockedNoChain');
  assert.deepEqual(canQueue(target, term, [item()], A1, n3), { ok: true, chained: true });
  assert.equal(canQueue(target, term, [item({ status: 'needs_revision' })], A1, n2).ok, true, 'a revision can be queued');
});
