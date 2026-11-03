// Withdrawing a round (requirements R6). The only code that deletes anything on the
// platform, and only on an explicit, confirmed request from the queue page.
//
// Same injected deps as engine.js, plus store.{requeueWithImages, addItemWithImages}.
//
// request = {
//   assignmentId, nodeId,
//   submissionId,        the round the user confirmed; nothing else is ever deleted
//   replacement,         optional { imageIds, title }: images already stored (stageImages)
// }
// Resolves with { ok: true, itemId } or { ok: false, reason, detail? }. On a refusal the
// caller still owns the replacement images and discards them.

import { ApiError } from './adapter.js';
import { applyReconcile } from './engine.js';
import { findAssignment, latestSubmission, nodeSubmissions, selectTerm, sid } from './model.js';

const LOCK_WAIT_MS = 15_000;

export async function withdrawRound(deps, request, { owner = crypto.randomUUID(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { audit } = deps;
  const ctx = { action: 'withdraw', assignmentId: sid(request.assignmentId), nodeId: sid(request.nodeId), submissionId: sid(request.submissionId) };

  const settings = await deps.settings.get();
  if (settings.dryRun) {
    await audit({ ...ctx, result: 'dry run' });
    return { ok: false, reason: 'reasonWithdrawDryRun' };
  }

  // Hold the tick lock: no check may submit to this node while we delete its round.
  const until = deps.now() + LOCK_WAIT_MS;
  while (!(await deps.lock.acquire(owner))) {
    if (deps.now() >= until) return { ok: false, reason: 'reasonBusy' };
    await wait(250);
  }
  try {
    return await withdrawLocked(deps, request, ctx);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await deps.settings.set({ sessionInvalid: true });
      return { ok: false, reason: 'sessionInvalid' };
    }
    await audit({ ...ctx, result: 'error', message: e?.message || String(e) });
    return { ok: false, reason: 'reasonServerRejected', detail: e?.message || String(e) };
  } finally {
    await deps.lock.release(owner);
  }
}

async function withdrawLocked(deps, request, ctx) {
  const { api, store, audit } = deps;
  const token = await deps.getToken({});
  if (!token) return { ok: false, reason: 'sessionInvalid' };
  api.setToken(token);
  const termId = (await deps.settings.get()).activeTermId || selectTerm(await api.courses())?.termId;
  if (!termId) return { ok: false, reason: 'why_noTerm' };

  // 1. Re-read: the confirmed round must still be the node's latest, and not in review.
  let term = await api.weeks(termId);
  let assignment = findAssignment(term, ctx.assignmentId);
  const latest = latestSubmission(assignment, ctx.nodeId);
  if (!latest || sid(latest.submissionId) !== ctx.submissionId) {
    await audit({ ...ctx, result: 'refused: round changed' });
    return { ok: false, reason: 'reasonRoundChanged' };
  }
  if (latest.status !== 'SUBMITTED') {
    await audit({ ...ctx, result: `refused: ${latest.status}` });
    return { ok: false, reason: latest.status === 'REVIEWING' ? 'reasonReviewStarted' : 'reasonRoundChanged' };
  }

  // 2. The write. Never retried.
  try {
    await api.withdrawSubmission(ctx.assignmentId, ctx.nodeId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    if (!(e instanceof ApiError) || e.status === 0) {
      // In doubt: the next check settles the item from the platform (R6.5, R6.6).
      await audit({ ...ctx, result: 'in doubt', message: e?.message });
      return { ok: false, reason: 'reasonWithdrawInDoubt' };
    }
    await audit({ ...ctx, result: 'rejected', status: e.status, message: e.message });
    return { ok: false, reason: 'reasonServerRejected', detail: e.message };
  }

  // 3. Confirm the round is gone.
  term = await api.weeks(termId);
  assignment = findAssignment(term, ctx.assignmentId);
  const subs = nodeSubmissions(assignment, ctx.nodeId);
  if (subs.some((s) => sid(s.submissionId) === ctx.submissionId)) {
    await audit({ ...ctx, result: 'not confirmed' });
    return { ok: false, reason: 'reasonWithdrawInDoubt' };
  }
  await audit({ ...ctx, result: 'ok' });

  // 4. Our item for that round: withdrawn, or queued again with the replacement.
  const ours = (await store.listBacklog()).find((i) => sid(i.submissionId) === ctx.submissionId
    && i.assignmentId === ctx.assignmentId && i.nodeId === ctx.nodeId);
  let itemId = ours?.id ?? null;
  const replacement = request.replacement;
  if (replacement?.imageIds?.length) {
    if (ours) {
      await store.requeueWithImages(ours.id, replacement.imageIds, subs.length, ours.status);
    } else {
      itemId = (await store.addItemWithImages({
        imageIds: replacement.imageIds, assignmentId: ctx.assignmentId, nodeId: ctx.nodeId,
        title: replacement.title, roundsAtQueue: subs.length,
      })).id;
    }
    await audit({ ...ctx, action: 'enqueue', itemId, result: ours ? 'replaced after withdraw' : 'added after withdraw' });
  } else if (ours) {
    await store.patchItem(ours.id, { status: 'withdrawn', reason: 'reasonWithdrawn' }, ours.status);
  }

  // 5. Settle the rest of the node (follow-up baselines, R6.7) from the fresh tree.
  await applyReconcile(deps, term);
  return { ok: true, itemId, replaced: !!replacement?.imageIds?.length };
}
