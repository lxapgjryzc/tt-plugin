// Requirements R1 (several images per submission) and R3 (完整作业 reminder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTerm, ids, item, fakeServer, fakeDeps, target } from './fixtures.mjs';
import { runTick } from '../app/src/engine.js';
import { ApiError } from '../app/src/adapter.js';
import { submissionHasFile, resolveDialogNode, siteTypeLabel, finalSubmissionsDue } from '../app/src/model.js';
import { imageProblem, imageSetProblem } from '../app/src/images.js';

const three = () => item({ imageIds: ['i1', 'i2', 'i3'] });

test('three images go out as one round with a comma-joined fileUrl, in order', async () => {
  const api = fakeServer(makeTerm());
  const it = three();
  const deps = fakeDeps(api, [it]);
  for (let i = 0; i < 3; i++) { await runTick(deps); deps.advance(60_000); }
  assert.equal(api.calls.upload, 3);
  assert.equal(api.calls.post, 1);
  const names = api.calls.fileUrls[0].split(',');
  assert.equal(names.length, 3);
  assert.deepEqual(names.map((n) => n.split('-').pop()), ['i1.png', 'i2.png', 'i3.png']);
  const cur = deps.items.get(it.id);
  assert.equal(cur.status, 'pending', 'the round was recognised as ours');
  assert.deepEqual(cur.objectNames, names);
});

test('a failed upload resumes with the next image, earlier ones are not uploaded again', async () => {
  const api = fakeServer(makeTerm());
  const upload = api.upload;
  let n = 0;
  api.upload = async (...args) => {
    if (++n === 2) throw new ApiError(503, null, 'HTTP 503');
    return upload(...args);
  };
  const it = three();
  const deps = fakeDeps(api, [it]);
  await runTick(deps);
  assert.equal(deps.items.get(it.id).status, 'queued');
  assert.equal(deps.items.get(it.id).objectNames.length, 1, 'first image kept');
  deps.advance(120_000);
  await runTick(deps);
  assert.equal(n, 4, 'one failed call, then only images 2 and 3');
  assert.equal(api.calls.post, 1);
  assert.equal(api.calls.fileUrls[0].split(',').length, 3);
});

test('worker killed after a multi-image POST landed: no duplicate', async () => {
  const api = fakeServer(makeTerm());
  const it = three();
  const deps = fakeDeps(api, [it]);
  api.onSubmit(async () => { throw new ApiError(0, null, 'evicted'); });
  await runTick(deps);
  assert.equal(deps.items.get(it.id).status, 'submitting');
  api.onSubmit(null);
  deps.advance(60_000);
  await runTick(deps);
  assert.equal(deps.items.get(it.id).status, 'pending');
  assert.equal(api.calls.post, 1);
});

test('round matching: any of our names, comma-joined keys, full URLs', () => {
  const joined = { fileObjectName: 'assignments/a.png,assignments/b.png' };
  assert.ok(submissionHasFile(joined, ['assignments/b.png']));
  assert.ok(submissionHasFile(joined, 'assignments/a.png'));
  assert.ok(!submissionHasFile(joined, ['assignments/c.png']));
  assert.ok(submissionHasFile({ fileUrls: ['https://cdn.example/assignments/b.png'] }, ['assignments/a.png', 'assignments/b.png']));
  assert.ok(!submissionHasFile(joined, []));
});

test('image rules: types, size, empty, count', () => {
  const img = (type, size = 10) => ({ type, size });
  assert.equal(imageProblem(target, img('image/png')), null);
  assert.equal(imageProblem(target, img('image/gif')), null);
  assert.equal(imageProblem(target, img('image/heic')), 'errImageType');
  assert.equal(imageProblem(target, img('text/plain')), 'errNotImage');
  assert.equal(imageProblem(target, img('image/png', 0)), 'errEmptyFile');
  assert.equal(imageProblem(target, img('image/png', 10 * 1024 * 1024 + 1)), 'errTooLarge');
  assert.equal(imageSetProblem(target, []), 'errNoImage');
  assert.equal(imageSetProblem(target, [img('image/png'), img('image/png'), img('image/png')]), null);
  assert.equal(imageSetProblem(target, [1, 2, 3, 4].map(() => img('image/png'))), 'errTooManyImages');
  assert.equal(imageSetProblem(target, [img('image/png'), img('image/bmp')]), 'errImageType');
});

// ---- learning page dialog → node -------------------------------------------

const catalog = {
  chapters: [
    { groupTitle: 'L6 头部结构', assignments: [
      { assignmentId: '1', assignmentType: 'BASIC', nodes: [{ nodeId: '11', title: '节点一 头部透临' }, { nodeId: '12', title: '节点二' }] },
      { assignmentId: '2', assignmentType: 'ADVANCED', nodes: [{ nodeId: '21', title: '节点二' }] },
    ] },
    { groupTitle: '毕业设计', assignments: [
      { assignmentId: '3', assignmentType: 'GRADUATION', stageNo: 1, nodes: [{ nodeId: '31', title: '节点1-1' }] },
      { assignmentId: '4', assignmentType: 'GRADUATION', stageNo: 2, nodes: [{ nodeId: '41', title: '节点1-1' }] },
    ] },
    { groupTitle: '预科', assignments: [{ assignmentId: '5', assignmentType: 'BASIC', nodes: [] }] },
  ],
};

test('dialog context resolves to exactly one node, by chapter, type label and node title', () => {
  assert.deepEqual(resolveDialogNode(catalog, { chapterTitle: 'L6 头部结构', typeLabel: '进阶作业', nodeTitle: '节点二' }), { assignmentId: '2', nodeId: '21' });
  assert.deepEqual(resolveDialogNode(catalog, { chapterTitle: 'L6 头部结构', typeLabel: '基础作业', nodeTitle: '节点一  头部透临' }), { assignmentId: '1', nodeId: '11' }, 'whitespace-insensitive');
  assert.deepEqual(resolveDialogNode(catalog, { chapterTitle: '毕业设计', typeLabel: '毕设阶段二', nodeTitle: '节点1-1' }), { assignmentId: '4', nodeId: '41' });
  assert.deepEqual(resolveDialogNode(catalog, { chapterTitle: '预科', typeLabel: '基础作业', nodeTitle: null }), { assignmentId: '5', nodeId: null });
  assert.deepEqual(resolveDialogNode(catalog, { chapterTitle: 'L6 头部结构', typeLabel: '基础作业', nodeTitle: '完整作业' }), { error: 'reasonFinalSubmission' });
  assert.deepEqual(resolveDialogNode(catalog, { chapterTitle: 'L6 头部结构', typeLabel: '基础作业', nodeTitle: '节点九' }), { error: 'reasonNodeMissing' });
  const dup = { chapters: [catalog.chapters[0], catalog.chapters[0]] };
  assert.deepEqual(resolveDialogNode(dup, { chapterTitle: 'L6 头部结构', typeLabel: '进阶作业', nodeTitle: '节点二' }), { error: 'reasonAmbiguousNode' });
  assert.equal(siteTypeLabel({ assignmentType: 'GRADUATION' }), '毕业设计');
});

// ---- 完整作业 reminder ----------------------------------------------------------

test('完整作业 is due when every node is approved and nothing was submitted', () => {
  const term = makeTerm();
  const [A1, A2] = term.weeks[0].lessons[0].assignments;
  assert.deepEqual(finalSubmissionsDue(term), []);
  for (const n of A1.nodes) n.status = 'APPROVED';
  A1.assignmentType = 'BASIC';
  assert.deepEqual(finalSubmissionsDue(term).map((a) => a.assignmentId), [ids.A1]);
  A1.finalSubmission = { submissionId: '9' };
  assert.deepEqual(finalSubmissionsDue(term), []);
  A1.finalSubmission = null;
  A1.assignmentType = 'GRADUATION';
  assert.deepEqual(finalSubmissionsDue(term), [], 'graduation projects have no 完整作业');
  for (const n of A2.nodes) n.status = 'APPROVED';
  A2.status = 'CLOSED';
  assert.deepEqual(finalSubmissionsDue(term), [], 'closed assignments are left out');
});
