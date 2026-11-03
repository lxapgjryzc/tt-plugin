// Requirements R2: follow-up submissions on a node that is not approved yet.
// Scenario numbers refer to docs/requirements.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTerm, ids, item, fakeServer, fakeDeps, setStatus, addRound } from './fixtures.mjs';
import { runTick } from '../app/src/engine.js';
import { needsAttention } from '../app/src/scheduler.js';

const onNode = (over = {}) => item({ roundsAtQueue: 0, ...over });
const writes = (api) => api.calls.post + api.calls.put;

async function ticks(deps, n = 3) {
  for (let i = 0; i < n; i++) { deps.advance(60_000); await runTick(deps); }
}

test('1/5: follow-up queued before anything was sent waits, then goes once the node is returned', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  const a = onNode();
  const b = onNode();
  const deps = fakeDeps(api, [a, b]);
  await ticks(deps);
  assert.equal(writes(api), 1, 'only the first goes out');
  assert.equal(deps.items.get(a.id).status, 'pending');
  assert.equal(deps.items.get(b.id).status, 'queued', 'our own round does not count as submitted elsewhere');
  assert.equal(deps.items.get(b.id).roundsAtQueue, 1, 'baseline moved past our own round');
  assert.equal(deps.snapshots.at(-1).notes[b.id], 'waitSameNode');

  setStatus(term, ids.A1, ids.A1n2, 'RETURNED', { teacherFeedback: '继续' });
  await ticks(deps);
  assert.equal(api.calls.put, 1, 'follow-up sent once, as PUT');
  assert.equal(writes(api), 2);
  assert.equal(deps.items.get(b.id).status, 'pending');
  assert.equal(deps.items.get(a.id).status, 'continued');
  assert.equal(deps.items.get(a.id).teacherFeedback, '继续', 'feedback kept');
});

test('2: several follow-ups go out one per review cycle, in queue order', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  const [a, b, c] = [onNode(), onNode(), onNode()];
  const deps = fakeDeps(api, [a, b, c]);
  await ticks(deps);
  setStatus(term, ids.A1, ids.A1n2, 'RETURNED');
  await ticks(deps);
  assert.equal(deps.items.get(b.id).status, 'pending');
  assert.equal(deps.items.get(c.id).status, 'queued');
  setStatus(term, ids.A1, ids.A1n2, 'RETURNED');
  await ticks(deps);
  assert.equal(deps.items.get(c.id).status, 'pending');
  setStatus(term, ids.A1, ids.A1n2, 'APPROVED');
  await ticks(deps);
  assert.equal(writes(api), 3);
  assert.deepEqual([a, b, c].map((x) => deps.items.get(x.id).status), ['continued', 'continued', 'done']);
});

test('3: TA approves directly: the follow-up is skipped, nothing is stuck, later nodes go', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  const a = onNode();
  const b = onNode();
  const next = item({ nodeId: ids.A1n3, roundsAtQueue: 0 }); // locked, chained behind node 2
  const deps = fakeDeps(api, [a, b, next]);
  await ticks(deps);
  assert.equal(deps.items.get(next.id).status, 'queued');
  setStatus(term, ids.A1, ids.A1n2, 'APPROVED');
  await ticks(deps);
  assert.equal(deps.items.get(a.id).status, 'done');
  assert.equal(deps.items.get(b.id).status, 'skipped');
  assert.equal(deps.items.get(b.id).reason, 'reasonApprovedBeforeSent');
  assert.equal(deps.items.get(next.id).status, 'pending', 'the next node was submitted');
  assert.equal(writes(api), 2, 'the follow-up was never sent');
  assert.deepEqual(needsAttention([...deps.items.values()]), [], 'nothing needs attention');
  assert.ok(deps.auditLog.some((e) => e.action === 'reconcile' && e.itemId === b.id && e.result === 'queued -> skipped'));
});

test('4: a round submitted on the site still blocks the follow-up', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  const a = onNode();
  const b = onNode();
  const deps = fakeDeps(api, [a, b]);
  await ticks(deps, 1);
  addRound(term, ids.A1, ids.A1n2, 'SUBMITTED', { fileObjectName: 'assignments/from-site.jpg' });
  await ticks(deps, 1);
  assert.equal(deps.items.get(b.id).status, 'blocked');
  assert.equal(deps.items.get(b.id).reason, 'reasonSubmittedElsewhere');
  setStatus(term, ids.A1, ids.A1n2, 'RETURNED');
  await ticks(deps);
  assert.equal(writes(api), 1, 'nothing else was sent');
});

test('6: approval arriving during the follow-up upload skips it at preflight', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  const a = onNode();
  const b = onNode();
  const deps = fakeDeps(api, [a, b]);
  await ticks(deps, 1);
  setStatus(term, ids.A1, ids.A1n2, 'RETURNED');
  const upload = api.upload;
  api.upload = async (...args) => {
    setStatus(term, ids.A1, ids.A1n2, 'APPROVED');
    return upload(...args);
  };
  await ticks(deps, 1);
  assert.equal(deps.items.get(b.id).status, 'skipped');
  assert.equal(writes(api), 1, 'no write after the approval');
  await ticks(deps);
  assert.equal(deps.items.get(a.id).status, 'done');
  assert.equal(writes(api), 1);
});

test('a returned item stops needing attention once a follow-up is queued', () => {
  const returned = item({ status: 'needs_revision' });
  assert.equal(needsAttention([returned]).length, 1);
  assert.equal(needsAttention([returned, item()]).length, 0);
  assert.equal(needsAttention([returned, item({ nodeId: ids.A2n1, assignmentId: ids.A2 })]).length, 1, 'other nodes do not count');
  assert.equal(needsAttention([item({ status: 'skipped' }), item({ status: 'continued' })]).length, 0);
});
