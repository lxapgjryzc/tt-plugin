// Requirements R6: withdrawing a submission. Scenario numbers refer to docs/requirements.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTerm, ids, item, fakeServer, fakeDeps, setStatus, addRound } from './fixtures.mjs';
import { runTick } from '../app/src/engine.js';
import { withdrawRound } from '../app/src/withdraw.js';
import { ApiError } from '../app/src/adapter.js';

const writes = (api) => api.calls.post + api.calls.put;
const latestId = (term, nodeId = ids.A1n2) => term.weeks[0].lessons[0].assignments[0].submissions.filter((s) => s.nodeId === nodeId).at(-1)?.submissionId;
const request = (term, extra = {}) => ({ assignmentId: ids.A1, nodeId: ids.A1n2, submissionId: latestId(term), ...extra });

// A pending item A on A1/node 2 with a follow-up B queued behind it.
async function sentWithFollowUp(settings = {}) {
  const term = makeTerm({ limit: 1 });
  const api = fakeServer(term);
  const a = item({ roundsAtQueue: 0 });
  const b = item({ roundsAtQueue: 0 });
  const deps = fakeDeps(api, [a, b], settings);
  await runTick(deps, { manual: true });
  assert.equal(deps.items.get(a.id).status, 'pending');
  return { term, api, deps, a, b };
}

test('1: withdraw our round: one DELETE, item withdrawn, the follow-up goes next', async () => {
  const { term, api, deps, a, b } = await sentWithFollowUp();
  const res = await withdrawRound(deps, request(term));
  assert.deepEqual(res, { ok: true, itemId: a.id, replaced: false });
  assert.equal(api.calls.delete, 1);
  assert.equal(deps.items.get(a.id).status, 'withdrawn');
  assert.equal(deps.items.get(b.id).roundsAtQueue, 0, 'baseline lowered to the remaining rounds');
  deps.advance(60_000);
  await runTick(deps);
  assert.equal(deps.items.get(b.id).status, 'pending', 'the freed slot went to the follow-up');
  assert.equal(api.calls.post, 2, 'the node had no rounds left, so POST again');
  assert.ok(deps.auditLog.some((e) => e.action === 'withdraw' && e.result === 'ok'));
});

test('2: withdraw and replace: same item queued with the new images, sent before the follow-up', async () => {
  const { term, api, deps, a, b } = await sentWithFollowUp();
  const res = await withdrawRound(deps, request(term, { replacement: { imageIds: ['n1', 'n2'], title: 'x' } }));
  assert.equal(res.ok, true);
  assert.equal(res.itemId, a.id);
  const cur = deps.items.get(a.id);
  assert.equal(cur.status, 'queued');
  assert.deepEqual(cur.imageIds, ['n1', 'n2']);
  assert.equal(cur.submissionId, null);
  deps.advance(60_000);
  await runTick(deps);
  assert.equal(deps.items.get(a.id).status, 'pending', 'the replacement went first');
  assert.equal(deps.items.get(b.id).status, 'queued');
  assert.equal(api.calls.fileUrls.at(-1).split(',').length, 2);
  assert.equal(writes(api), 2);
});

test('2b: replacing a round submitted on the site queues a new item ahead of follow-ups', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED', { fileObjectName: 'assignments/site.jpg' });
  const b = item({ roundsAtQueue: 1, order: 1 });
  const deps = fakeDeps(api, [b], { activeTermId: term.termId });
  const res = await withdrawRound(deps, request(term, { replacement: { imageIds: ['n1'], title: 'L7 / 节点2' } }));
  assert.equal(res.ok, true);
  const added = deps.items.get(res.itemId);
  assert.ok(added.order < b.order, 'ahead of the follow-up');
  await runTick(deps);
  assert.equal(added.id, [...deps.items.values()].find((i) => i.status === 'pending').id);
  assert.equal(deps.items.get(b.id).status, 'queued', 'the follow-up still waits, not blocked');
});

test('3: refused without a DELETE when review started or another round is latest', async () => {
  const { term, api, deps } = await sentWithFollowUp();
  const stale = request(term, { submissionId: '1' });
  assert.equal((await withdrawRound(deps, stale)).reason, 'reasonRoundChanged');
  setStatus(term, ids.A1, ids.A1n2, 'REVIEWING');
  assert.equal((await withdrawRound(deps, request(term))).reason, 'reasonReviewStarted');
  assert.equal(api.calls.delete ?? 0, 0);
});

test('4: dry run refuses', async () => {
  const { term, api, deps } = await sentWithFollowUp();
  await deps.settings.set({ dryRun: true });
  assert.equal((await withdrawRound(deps, request(term))).reason, 'reasonWithdrawDryRun');
  assert.equal(api.calls.delete ?? 0, 0);
});

test('5: response lost: settled from the platform on the next check', async () => {
  // Applied on the server, response lost.
  let s = await sentWithFollowUp();
  s.api.onWithdraw(async () => { throw new ApiError(0, null, 'Failed to fetch'); });
  assert.equal((await withdrawRound(s.deps, request(s.term))).reason, 'reasonWithdrawInDoubt');
  assert.equal(s.deps.items.get(s.a.id).status, 'pending', 'nothing assumed');
  s.deps.advance(60_000);
  await runTick(s.deps);
  assert.equal(s.deps.items.get(s.a.id).status, 'withdrawn');

  // Never reached the server.
  s = await sentWithFollowUp();
  s.api.withdrawSubmission = async () => { throw new ApiError(0, null, 'Failed to fetch'); };
  assert.equal((await withdrawRound(s.deps, request(s.term))).reason, 'reasonWithdrawInDoubt');
  s.deps.advance(60_000);
  await runTick(s.deps);
  assert.equal(s.deps.items.get(s.a.id).status, 'pending');
  assert.equal(writes(s.api), 1, 'no automatic retry, nothing else sent');
});

test('6: withdrawn on the site: item withdrawn, baseline lowered, a later site round still blocks', async () => {
  const { term, api, deps, a, b } = await sentWithFollowUp({ autoSubmit: false });
  await api.withdrawSubmission(ids.A1, ids.A1n2); // the student, on the site
  deps.advance(60_000);
  await runTick(deps);
  assert.equal(deps.items.get(a.id).status, 'withdrawn');
  assert.equal(deps.items.get(a.id).reason, 'reasonWithdrawnElsewhere');
  assert.equal(deps.items.get(b.id).roundsAtQueue, 0);
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED', { fileObjectName: 'assignments/site-again.jpg' });
  deps.advance(60_000);
  await runTick(deps);
  assert.equal(deps.items.get(b.id).status, 'blocked');
  assert.equal(deps.items.get(b.id).reason, 'reasonSubmittedElsewhere');
});
