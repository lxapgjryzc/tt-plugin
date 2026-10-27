// One scheduler tick. All side effects go through injected deps so this runs in Node tests.
//
// deps = {
//   target, api,
//   store:    { listBacklog, patchItem(id, patch, expectStatus), getImage(id) },
//   settings: { get(), set(patch) },
//   lock:     { acquire(owner), refresh(owner), release(owner) },
//   audit(entry), getToken({ fresh }), saveSnapshot(snap), now()
// }

import { ApiError } from './adapter.js';
import { reconcile } from './reconcile.js';
import { schedule, preflight, backoffMs, MAX_ATTEMPTS } from './scheduler.js';
import { selectTerm, findAssignment, findNode, nodeSubmissions, pendingSubmissions, label } from './model.js';

// Preflight failures that send the item back to the queue; the next tick decides afresh.
const TRANSIENT_PREFLIGHT = new Set(['atLimit', 'reasonLocked', 'reasonPendingOnNode', 'reasonNodeChanged', 'noTerm']);

export function summarize(target, term, decision, error = null) {
  const pend = term
    ? pendingSubmissions(target, term).map(({ assignment, submission }) => ({
        assignmentId: String(assignment.assignmentId),
        nodeId: submission.nodeId === null ? null : String(submission.nodeId),
        label: label(assignment, findNode(assignment, submission.nodeId)),
        status: submission.status,
        queuePosition: submission.queuePosition ?? null,
        estimatedWaitMinutes: submission.estimatedWaitMinutes ?? null,
      }))
    : [];
  return {
    at: new Date().toISOString(),
    termId: term ? String(term.termId) : null,
    termName: term?.termName ?? null,
    courseName: term?.courseName ?? null,
    limit: term ? Number(term.maxPendingSubmissions) : null,
    pending: pend,
    why: decision?.why ?? null,
    notes: decision?.notes ?? {},
    order: decision?.order ?? [],
    prio: decision?.prio ?? {},
    nextId: decision?.next?.id ?? null,
    error,
  };
}

export async function runTick(deps, { manual = false, owner = crypto.randomUUID() } = {}) {
  const { target, api, store, audit } = deps;
  let settings = await deps.settings.get();
  if (settings.paused && !manual) return { why: 'paused' };

  if (!(await deps.lock.acquire(owner))) return { why: 'locked' };
  try {
    return await tickLocked(deps, settings, { manual, owner });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await deps.settings.set({ sessionInvalid: true });
      await deps.dropToken?.();
      await audit({ action: 'session', result: 'invalid' });
      await deps.saveSnapshot(summarize(target, null, { why: 'sessionInvalid' }, 'sessionInvalid'));
      return { why: 'sessionInvalid' };
    }
    const msg = e?.message || String(e);
    await audit({ action: 'tick', result: 'error', message: msg });
    await deps.saveSnapshot(summarize(target, null, { why: 'error' }, msg));
    return { why: 'error', error: msg };
  } finally {
    await deps.lock.release(owner);
  }
}

async function tickLocked(deps, settings, { manual, owner }) {
  const { target, api, store, audit } = deps;

  const token = await deps.getToken({ fresh: settings.sessionInvalid });
  if (!token) {
    await deps.saveSnapshot(summarize(target, null, { why: 'noToken' }, 'NO_TAB'));
    return { why: 'noToken' };
  }
  api.setToken(token);

  let termId = settings.activeTermId;
  if (!termId) {
    const t = selectTerm(await api.courses());
    if (!t) {
      await deps.saveSnapshot(summarize(target, null, { why: 'noTerm' }));
      return { why: 'noTerm' };
    }
    termId = String(t.termId);
    settings = await deps.settings.set({ activeTermId: termId });
  }

  let term = await api.weeks(termId);
  if (settings.sessionInvalid) settings = await deps.settings.set({ sessionInvalid: false });

  // 1. Reconcile local backlog against the server.
  await applyReconcile(deps, term);

  // 2. Decide.
  let backlog = await store.listBacklog();
  // Pause is honoured even for a manual tick: manual only overrides autoSubmit.
  const decision = schedule({ target, term, backlog, settings, now: deps.now(), manual });
  for (const b of decision.blocks) {
    await store.patchItem(b.id, { status: 'blocked', reason: b.reason, reasonDetail: b.detail }, 'queued');
    await audit({ action: 'block', itemId: b.id, result: b.reason });
  }
  await deps.saveSnapshot(summarize(target, term, decision));

  if (decision.action !== 'submit') {
    if (decision.why === 'atLimit') await audit({ action: 'tick', result: 'at limit', pending: decision.pending, limit: decision.limit });
    return { why: decision.why };
  }

  const item = decision.item;
  const ctx = { action: 'submit', itemId: item.id, assignmentId: item.assignmentId, nodeId: item.nodeId };

  if (settings.dryRun) {
    await audit({ ...ctx, result: 'dry run', method: decision.method, roundsBefore: decision.roundsBefore });
    return { why: 'dryRun', method: decision.method, itemId: item.id };
  }

  // 3. Upload (reuse an earlier objectName if we have one).
  if (!(await store.patchItem(item.id, { status: 'uploading', reason: null }, 'queued'))) return { why: 'raced' };
  let objectName = item.objectName;
  if (!objectName) {
    const img = await store.getImage(item.imageId);
    if (!img?.blob) {
      await store.patchItem(item.id, { status: 'failed', reason: 'reasonImageMissing' }, 'uploading');
      return { why: 'imageMissing' };
    }
    if (img.blob.size > target.maxUploadBytes) {
      await store.patchItem(item.id, { status: 'blocked', reason: 'reasonTooLarge' }, 'uploading');
      return { why: 'tooLarge' };
    }
    try {
      objectName = (await api.upload(img.blob, img.name)).objectName;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw e;
      const attempts = (item.attempts || 0) + 1;
      const retryable = e instanceof ApiError && e.retryable;
      if (retryable && attempts < MAX_ATTEMPTS) {
        await store.patchItem(item.id, {
          status: 'queued', reason: 'reasonUploadRetry', reasonDetail: e.message,
          attempts, nextAttemptAt: deps.now() + backoffMs(attempts),
        }, 'uploading');
      } else {
        await store.patchItem(item.id, {
          status: retryable ? 'failed' : 'blocked', reason: 'reasonUploadFailed', reasonDetail: e.message, attempts,
        }, 'uploading');
      }
      await audit({ ...ctx, action: 'upload', result: 'error', status: e?.status ?? null, message: e?.message });
      return { why: 'uploadError' };
    }
    await store.patchItem(item.id, { objectName, attempts: 0, nextAttemptAt: null }, 'uploading');
    await audit({ ...ctx, action: 'upload', result: 'ok' });
  }

  // 4. Re-read state immediately before the write. This is the double-submit guard.
  await deps.lock.refresh(owner);
  settings = await deps.settings.get();
  term = await api.weeks(termId);
  const assignment = findAssignment(term, item.assignmentId);
  const roundsBefore = nodeSubmissions(assignment, item.nodeId).length;
  const blocker = settings.paused
    ? 'paused'
    : preflight({ target, term, item, roundsBefore: decision.roundsBefore });
  if (blocker) {
    const transient = blocker === 'paused' || TRANSIENT_PREFLIGHT.has(blocker);
    await store.patchItem(item.id, transient
      ? { status: 'queued', reason: null }
      : { status: 'blocked', reason: blocker }, 'uploading');
    await audit({ ...ctx, result: `preflight: ${blocker}` });
    // A round may have appeared that is ours (e.g. a previous lost request).
    await applyReconcile(deps, term);
    return { why: `preflight:${blocker}` };
  }
  const method = roundsBefore === 0 ? 'POST' : 'PUT';

  // Forget any earlier round this item was tracking: from here on it follows the new one.
  if (!(await store.patchItem(item.id, { status: 'submitting', roundsBefore, submissionId: null, submitStartedAt: deps.now() }, 'uploading'))) {
    return { why: 'raced' };
  }

  // 5. The one write that matters. Never retried in this tick.
  try {
    if (method === 'POST') await api.createSubmission(item.assignmentId, item.nodeId, objectName);
    else await api.updateSubmission(item.assignmentId, item.nodeId, objectName);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    await audit({ ...ctx, method, result: 'error', status: e?.status ?? null, message: e?.message });
    if (!(e instanceof ApiError) || e.status === 0) {
      // In doubt: leave `submitting`. The next tick resolves it from server state.
      return { why: 'submitInDoubt' };
    }
    // Server rejected. Re-read and trust the server, not the local model.
    try {
      term = await api.weeks(termId);
      await applyReconcile(deps, term);
    } catch { /* next tick will reconcile */ }
    const cur = (await store.listBacklog()).find((i) => i.id === item.id);
    if (cur && (cur.status === 'queued' || cur.status === 'submitting')) {
      await store.patchItem(item.id, { status: 'blocked', reason: 'reasonServerRejected', reasonDetail: e.message }, cur.status);
    }
    return { why: 'rejected', message: e.message };
  }

  await store.patchItem(item.id, { status: 'pending', reason: null }, 'submitting');
  await audit({ ...ctx, method, result: 'ok' });
  try {
    term = await api.weeks(termId);
    await applyReconcile(deps, term);
    backlog = await store.listBacklog();
    await deps.saveSnapshot(summarize(target, term, schedule({ target, term, backlog, settings, now: deps.now() })));
  } catch { /* reconciled next tick */ }
  return { why: 'submitted', method, itemId: item.id };
}

async function applyReconcile(deps, term) {
  const backlog = await deps.store.listBacklog();
  const byId = new Map(backlog.map((i) => [i.id, i]));
  for (const { id, patch } of reconcile({ target: deps.target, term, backlog })) {
    const prev = byId.get(id);
    const res = await deps.store.patchItem(id, patch, prev.status);
    if (res && patch.status && patch.status !== prev.status) {
      await deps.audit({
        action: 'reconcile', itemId: id, assignmentId: prev.assignmentId, nodeId: prev.nodeId,
        result: `${prev.status} -> ${patch.status}`,
      });
    }
  }
}
