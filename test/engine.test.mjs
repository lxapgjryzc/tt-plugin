import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTerm, ids, item, fakeServer, fakeDeps, setStatus } from './fixtures.mjs';
import { runTick } from '../extension/src/engine.js';

test('a single item submits exactly once across many ticks', async () => {
  const api = fakeServer(makeTerm());
  const deps = fakeDeps(api, [item()]);
  for (let i = 0; i < 5; i++) { await runTick(deps); deps.advance(60_000); }
  assert.equal(api.calls.post + api.calls.put, 1);
  assert.equal(api.calls.upload, 1);
  const [it] = deps.items.values();
  assert.equal(it.status, 'pending');
  assert.ok(it.submissionId);
  assert.equal(it.queuePosition, 3);
});

test('dry run never uploads or submits', async () => {
  const api = fakeServer(makeTerm());
  const deps = fakeDeps(api, [item()], { dryRun: true });
  const r = await runTick(deps);
  assert.equal(r.why, 'dryRun');
  assert.equal(api.calls.upload + api.calls.post + api.calls.put, 0);
  assert.ok(deps.auditLog.some((a) => a.result === 'dry run'));
});

test('at limit logs "at limit" and makes no write', async () => {
  const term = makeTerm({ limit: 1 });
  const api = fakeServer(term);
  const deps = fakeDeps(api, [item(), item({ assignmentId: ids.A2, nodeId: ids.A2n1 })]);
  await runTick(deps); deps.advance(60_000);
  await runTick(deps);
  assert.equal(api.calls.post, 1);
  assert.ok(deps.auditLog.some((a) => a.result === 'at limit'));
});

test('worker killed after the POST landed -> no duplicate on the next tick', async () => {
  const api = fakeServer(makeTerm());
  const deps = fakeDeps(api, [item()]);
  // Simulate eviction: the request reaches the server, then the worker dies.
  api.onSubmit(async () => { throw new Error('worker evicted'); });
  await runTick(deps).catch(() => {});
  api.onSubmit(null);
  const [mid] = deps.items.values();
  assert.equal(mid.status, 'submitting', 'left in doubt');
  // simulate the lock surviving the eviction (finally never ran)
  await deps.lock.acquire('dead-worker');
  deps.advance(30_000);
  assert.equal((await runTick(deps)).why, 'locked', 'fresh lock still blocks');
  deps.advance(200_000);
  for (let i = 0; i < 3; i++) { await runTick(deps); deps.advance(60_000); }
  assert.equal(api.calls.post + api.calls.put, 1, 'exactly one round');
  assert.equal([...deps.items.values()][0].status, 'pending');
});

test('worker killed before the request was sent -> submitted once later', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  const it = item({ status: 'submitting', objectName: 'assignments/u.jpg', roundsBefore: 0 });
  const deps = fakeDeps(api, [it]);
  await runTick(deps);
  assert.equal(api.calls.post, 1);
  assert.equal(api.calls.upload, 0, 'reuses the uploaded object');
  await runTick(deps);
  assert.equal(api.calls.post + api.calls.put, 1);
});

test('network failure on submit stays in doubt and is never blindly retried', async () => {
  const api = fakeServer(makeTerm());
  const deps = fakeDeps(api, [item()]);
  const realPost = api.createSubmission;
  // request lands, but the response is lost
  api.createSubmission = async (...a) => {
    await realPost(...a);
    const { ApiError } = await import('../extension/src/adapter.js');
    throw new ApiError(0, null, 'TIMEOUT');
  };
  assert.equal((await runTick(deps)).why, 'submitInDoubt');
  api.createSubmission = realPost;
  deps.advance(60_000);
  await runTick(deps);
  assert.equal(api.calls.post + api.calls.put, 1);
  assert.equal([...deps.items.values()][0].status, 'pending');
});

test('server rejection blocks the item with the message and is not retried', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  api.updateSubmission = async () => { const { ApiError } = await import('../extension/src/adapter.js'); throw new ApiError(200, 400, '提交次数已用完'); };
  term.weeks[0].lessons[0].assignments[0].submissions.push({ submissionId: '1', nodeId: ids.A1n2, status: 'REVIEWED' });
  term.weeks[0].lessons[0].assignments[0].nodes[1].status = 'REVIEWED';
  const deps = fakeDeps(api, [item()]);
  const r = await runTick(deps);
  assert.equal(r.why, 'rejected');
  const [it] = deps.items.values();
  assert.equal(it.status, 'blocked');
  assert.equal(it.reasonDetail, '提交次数已用完');
  deps.advance(60_000);
  await runTick(deps);
  assert.equal(deps.items.get(it.id).status, 'blocked');
});

test('RETURNED -> needs_revision and never auto-resubmitted', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  const deps = fakeDeps(api, [item()]);
  await runTick(deps);
  setStatus(term, ids.A1, ids.A1n2, 'RETURNED', { teacherFeedback: '比例不对' });
  for (let i = 0; i < 3; i++) { deps.advance(60_000); await runTick(deps); }
  const [it] = deps.items.values();
  assert.equal(it.status, 'needs_revision');
  assert.equal(it.teacherFeedback, '比例不对');
  assert.equal(api.calls.post + api.calls.put, 1);
});

test('429 on upload backs off and eventually gives up', async () => {
  const api = fakeServer(makeTerm());
  // The adapter does its own single retry; the fake counts every call as one attempt.
  api.failUploads(Array(50).fill(429));
  const deps = fakeDeps(api, [item()]);
  for (let i = 0; i < 30; i++) { await runTick(deps); deps.advance(61_000); }
  const [it] = deps.items.values();
  assert.equal(it.status, 'failed');
  assert.ok(api.calls.upload <= 6, `bounded uploads, got ${api.calls.upload}`);
  assert.equal(api.calls.post, 0);
});

test('non-retryable upload error blocks immediately', async () => {
  const api = fakeServer(makeTerm());
  api.failUploads([413]);
  const deps = fakeDeps(api, [item()]);
  await runTick(deps);
  assert.equal([...deps.items.values()][0].status, 'blocked');
  assert.equal(api.calls.upload, 1);
});

test('pause stops all activity within one tick, including mid-upload', async () => {
  const api = fakeServer(makeTerm());
  const deps = fakeDeps(api, [item()], { paused: true });
  assert.equal((await runTick(deps)).why, 'paused');
  assert.equal(api.calls.upload, 0);
  // paused while the upload was running
  await deps.settings.set({ paused: false });
  const realUpload = api.upload;
  api.upload = async (...a) => { const r = await realUpload(...a); await deps.settings.set({ paused: true }); return r; };
  await runTick(deps);
  assert.equal(api.calls.post, 0);
  assert.equal([...deps.items.values()][0].status, 'queued');
});

test('autoSubmit off only submits on a manual tick', async () => {
  const api = fakeServer(makeTerm());
  const deps = fakeDeps(api, [item()], { autoSubmit: false });
  assert.equal((await runTick(deps)).why, 'autoOff');
  assert.equal(api.calls.post, 0);
  assert.equal((await runTick(deps, { manual: true })).why, 'submitted');
  assert.equal(api.calls.post, 1);
});

test('sequential nodes: node 2 waits for node 1 approval, then goes', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  const n1 = item({ assignmentId: ids.A2, nodeId: ids.A2n1 });
  const n2 = item({ assignmentId: ids.A2, nodeId: ids.A2n2 });
  const deps = fakeDeps(api, [n1, n2]);
  await runTick(deps); deps.advance(60_000);
  await runTick(deps);
  assert.equal(api.calls.post, 1);
  assert.equal(deps.items.get(n2.id).status, 'queued');
  setStatus(term, ids.A2, ids.A2n1, 'APPROVED');
  deps.advance(60_000);
  await runTick(deps);
  assert.equal(deps.items.get(n1.id).status, 'done');
  assert.equal(api.calls.post, 2);
  assert.equal(deps.items.get(n2.id).status, 'pending');
});

test('401 marks the session invalid and pauses scheduling', async () => {
  const api = fakeServer(makeTerm());
  api.weeks = async () => { const { ApiError } = await import('../extension/src/adapter.js'); throw new ApiError(401, null, 'unauthorized'); };
  const deps = fakeDeps(api, [item()]);
  assert.equal((await runTick(deps)).why, 'sessionInvalid');
  assert.equal(deps.settingsValue.sessionInvalid, true);
  assert.equal(deps.lock.held, null, 'lock released');
});

test('queued chain survives a returned first node: later nodes wait, nothing is resubmitted', async () => {
  const term = makeTerm();
  const api = fakeServer(term);
  const n1 = item({ assignmentId: ids.A2, nodeId: ids.A2n1 });
  const n2 = item({ assignmentId: ids.A2, nodeId: ids.A2n2 });
  const deps = fakeDeps(api, [n1, n2]);
  await runTick(deps);
  assert.equal(api.calls.post, 1, 'node 1 goes out');
  setStatus(term, ids.A2, ids.A2n1, 'REVIEWED', { teacherFeedback: '重画' });
  for (let i = 0; i < 3; i++) { deps.advance(60_000); await runTick(deps); }
  assert.equal(deps.items.get(n1.id).status, 'needs_revision');
  assert.equal(deps.items.get(n2.id).status, 'queued', 'node 2 keeps waiting (still locked)');
  assert.equal(deps.snapshots.at(-1).notes[n2.id], 'waitLocked');
  assert.equal(api.calls.post + api.calls.put, 1, 'nothing else was sent');
  // user queues a revised node 1 (replaces the item), it goes out as a new round
  deps.items.set(n1.id, { ...deps.items.get(n1.id), status: 'queued', objectName: null, roundsAtQueue: 1 });
  deps.advance(60_000); await runTick(deps);
  assert.equal(api.calls.put, 1, 'revision sent once as PUT');
  // approved -> node 2 unlocks and goes out
  setStatus(term, ids.A2, ids.A2n1, 'APPROVED');
  deps.advance(60_000); await runTick(deps);
  assert.equal(deps.items.get(n1.id).status, 'done');
  assert.equal(api.calls.post, 2);
  assert.equal(deps.items.get(n2.id).status, 'pending');
});
