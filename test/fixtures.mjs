import { target } from './target.mock.js';
import { ApiError } from '../extension/src/adapter.js';

export { target };

let seq = 0;
export const id19 = () => String(9000000000000000000n + BigInt(++seq));

// term with: A1 (nodes n1 approved, n2 open, n3 locked), A2 (n1 open, n2 locked), A3 closed.
export function makeTerm({ limit = 2 } = {}) {
  const A1 = {
    assignmentId: '2000000000000000001', title: 'L7 形体优化', status: 'PUBLISHED', blockedReason: null, deadline: null,
    nodes: [
      { nodeId: '2000000000000000011', nodeOrder: 1, title: '节点1', status: 'APPROVED', locked: false },
      { nodeId: '2000000000000000012', nodeOrder: 2, title: '节点2', status: null, locked: false },
      { nodeId: '2000000000000000013', nodeOrder: 3, title: '节点3', status: null, locked: true },
    ],
    submissions: [
      { submissionId: '2000000000000000101', nodeId: '2000000000000000011', status: 'APPROVED', fileObjectName: 'assignments/old.jpg', fileObjectNames: ['assignments/old.jpg'] },
    ],
  };
  const A2 = {
    assignmentId: '2000000000000000002', title: 'L8 动态优化', status: 'PUBLISHED', blockedReason: null, deadline: null,
    nodes: [
      { nodeId: '2000000000000000021', nodeOrder: 1, title: '节点1', status: null, locked: false },
      { nodeId: '2000000000000000022', nodeOrder: 2, title: '节点2', status: null, locked: true },
    ],
    submissions: [],
  };
  const A3 = {
    assignmentId: '2000000000000000003', title: '基础作业', status: 'CLOSED', blockedReason: null, deadline: null,
    nodes: [{ nodeId: '2000000000000000031', nodeOrder: 1, title: '节点一', status: null, locked: false }],
    submissions: [],
  };
  return {
    termId: '2000000000000000000', termName: 'T', courseName: 'C', endDate: '2099-12-05',
    maxPendingSubmissions: limit, termStatus: 'STARTED', courseStatus: 'ACTIVE',
    weeks: [{ weekNumber: 0, lessons: [{ lessonId: '2000000000000000900', lessonNo: 1, title: 'L', assignments: [A1, A2, A3] }] }],
  };
}

export const ids = {
  A1: '2000000000000000001', A1n2: '2000000000000000012', A1n3: '2000000000000000013',
  A2: '2000000000000000002', A2n1: '2000000000000000021', A2n2: '2000000000000000022',
  A3: '2000000000000000003', A3n1: '2000000000000000031',
};

export function item(over = {}) {
  return {
    id: `item-${++seq}`, imageId: `img-${seq}`, assignmentId: ids.A1, nodeId: ids.A1n2, title: 'x',
    status: 'queued', reason: null, objectName: null, submissionId: null, roundsBefore: null,
    attempts: 0, nextAttemptAt: null, order: seq, createdAt: new Date(seq).toISOString(), ...over,
  };
}

// Adds a server-side round.
export function addRound(term, assignmentId, nodeId, status, extra = {}) {
  const a = term.weeks[0].lessons[0].assignments.find((x) => x.assignmentId === assignmentId);
  const s = { submissionId: id19(), nodeId, status, queuePosition: null, estimatedWaitMinutes: null, ...extra };
  a.submissions.push(s);
  const n = a.nodes.find((x) => x.nodeId === nodeId);
  if (n) n.status = status;
  return s;
}

export function setStatus(term, assignmentId, nodeId, status, extra = {}) {
  const a = term.weeks[0].lessons[0].assignments.find((x) => x.assignmentId === assignmentId);
  const subs = a.submissions.filter((s) => s.nodeId === nodeId);
  Object.assign(subs[subs.length - 1], { status, ...extra });
  a.nodes.find((x) => x.nodeId === nodeId).status = status;
  if (status === 'APPROVED') {
    const n = a.nodes.find((x) => x.nodeId === nodeId);
    const next = a.nodes.find((x) => x.nodeOrder === n.nodeOrder + 1);
    if (next) next.locked = false;
  }
}

// A fake platform that enforces the server rules and counts writes.
export function fakeServer(term) {
  const calls = { upload: 0, post: 0, put: 0, weeks: 0 };
  let uploadFailures = []; // queue of statuses to fail with
  let submitHook = null;
  const clone = () => structuredClone(term);
  const api = {
    calls,
    term,
    failUploads: (list) => { uploadFailures = [...list]; },
    onSubmit: (fn) => { submitHook = fn; },
    setToken() {}, hasToken: () => true, clearToken() {},
    courses: async () => [{ termId: term.termId, termStatus: 'STARTED' }],
    weeks: async () => { calls.weeks++; return clone(); },
    upload: async (blob, name) => {
      calls.upload++;
      if (uploadFailures.length) {
        const st = uploadFailures.shift();
        throw new ApiError(st, null, `HTTP ${st}`);
      }
      return { objectName: `assignments/2026/10/27/U1/${calls.upload}-${name}`, url: null };
    },
  };
  const submit = (method) => async (assignmentId, nodeId, fileUrl) => {
    calls[method]++;
    const a = term.weeks[0].lessons[0].assignments.find((x) => x.assignmentId === assignmentId);
    const n = a.nodes.find((x) => x.nodeId === nodeId);
    const pending = term.weeks[0].lessons[0].assignments
      .flatMap((x) => x.submissions).filter((s) => ['SUBMITTED', 'REVIEWING'].includes(s.status)).length;
    if (pending >= term.maxPendingSubmissions) throw new ApiError(200, 400, '待批改作业已达上限');
    if (n.locked) throw new ApiError(200, 400, '节点未解锁');
    if (['SUBMITTED', 'REVIEWING', 'APPROVED'].includes(n.status)) throw new ApiError(200, 400, '不可重复提交');
    addRound(term, assignmentId, nodeId, 'SUBMITTED', { fileObjectName: fileUrl, fileObjectNames: [fileUrl], queuePosition: 3, estimatedWaitMinutes: 40 });
    if (submitHook) await submitHook(method);
  };
  api.createSubmission = submit('post');
  api.updateSubmission = submit('put');
  return api;
}

export function fakeDeps(api, backlog, settingsOver = {}) {
  const items = new Map(backlog.map((i) => [i.id, { ...i }]));
  let settings = { activeTermId: null, paused: false, autoSubmit: true, dryRun: false, tickSeconds: 60, sessionInvalid: false, ...settingsOver };
  let lock = null;
  const audit = [];
  const snapshots = [];
  let clock = 1_000_000;
  return {
    items, auditLog: audit, snapshots,
    advance: (ms) => { clock += ms; },
    get settingsValue() { return settings; },
    target, api,
    now: () => clock,
    store: {
      listBacklog: async () => [...items.values()].map((i) => ({ ...i })),
      getImage: async (id) => ({ id, blob: new Blob(['png'], { type: 'image/png' }), name: `${id}.png` }),
      patchItem: async (id, patch, expect) => {
        const cur = items.get(id);
        if (!cur || (expect !== undefined && ![].concat(expect).includes(cur.status))) return null;
        const next = { ...cur, ...patch };
        items.set(id, next);
        return next;
      },
    },
    settings: {
      get: async () => ({ ...settings }),
      set: async (p) => { settings = { ...settings, ...p }; return { ...settings }; },
    },
    lock: {
      acquire: async (owner) => {
        if (lock && clock - lock.at < 180_000) return false;
        lock = { owner, at: clock };
        return true;
      },
      refresh: async (owner) => { if (lock?.owner === owner) lock.at = clock; return true; },
      release: async (owner) => { if (lock?.owner === owner) lock = null; },
      get held() { return lock; },
    },
    audit: async (e) => { audit.push(e); },
    saveSnapshot: async (s) => { snapshots.push(s); },
    getToken: async () => 'tok',
  };
}
