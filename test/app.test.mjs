// The background app (requirements R9): SQLite store, restarts, single instance, the local
// API's safety rules, session hand-over and wake-up checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../app/src/db.js';
import { makeStore } from '../app/src/store.js';
import { makeKv } from '../app/src/kv.js';
import { makeApp } from '../app/src/app.js';
import { makeServer } from '../app/src/server.js';
import { ApiError } from '../app/src/adapter.js';
import { makeTerm, ids, fakeServer, setStatus } from './fixtures.mjs';
import { target } from './target.mock.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'chamber-test-'));
const png = (n = 1) => ({ data: new Uint8Array([137, 80, 78, 71, n]), mime: 'image/png', name: `d${n}.png` });
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expSec) => `${b64url({ alg: 'HS512' })}.${b64url({ sub: '1', exp: expSec })}.sig`;
const secret = { protect: async (t) => `enc:${Buffer.from(t).toString('base64')}`, unprotect: async (c) => Buffer.from(c.slice(4), 'base64').toString() };
const silent = { show() {}, clear() {} };

// Timers the test fires by hand, with a clock it moves.
function fakeTimers(start = Date.parse('2026-11-03T03:00:00Z')) { // 11:00 Beijing, review hours
  let clock = start;
  let next = 1;
  const timers = new Map();
  return {
    now: () => clock,
    set: (fn, ms) => { const id = next++; timers.set(id, { fn, at: clock + ms }); return id; },
    clear: (id) => timers.delete(id),
    advance: (ms) => { clock += ms; },
    // Run every timer due by now (they may schedule more; those wait for the next call).
    async fire() {
      const due = [...timers.entries()].filter(([, t]) => t.at <= clock);
      for (const [id, t] of due) { timers.delete(id); await t.fn(); }
      return due.length;
    },
    pending: () => timers.size,
  };
}

function newApp(dir, over = {}) {
  const timers = over.timers || fakeTimers();
  const app = makeApp({
    dbFile: join(dir, 'chamber.sqlite'), target, secret, notifier: silent,
    now: timers.now, setTimer: timers.set, clearTimer: timers.clear, osLanguage: 'en-US', ...over,
  });
  return { app, timers };
}

async function readyApp(dir, api, over) {
  const r = newApp(dir, { api, ...over });
  r.app.tokens.store('tok'); // no expiry: always usable
  await r.app.kv.setSettings({ autoSubmit: true, dryRun: false, reviewHoursOn: false });
  return r;
}

// ---- 1, 2: the store -----------------------------------------------------------

test('store: enqueue, follow-ups, replace, CAS patch, in-flight removal, reorder, staged images, reopen', async () => {
  const dir = tmp();
  let db;
  try {
    const file = join(dir, 'c.sqlite');
    db = openDb(file);
    let store = makeStore(db);
    const a = (await store.enqueue({ images: [png(1), png(2)], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'A' })).item;
    const b = (await store.enqueue({ images: [png(3)], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'B' })).item;
    assert.equal(a.imageIds.length, 2);
    assert.ok(b.order > a.order, 'a follow-up goes after the earlier item');
    assert.equal((await store.getImage(a.imageIds[0])).blob.size, 5);
    assert.equal((await store.getImage(a.imageIds[0])).blob.type, 'image/png');

    assert.equal(await store.patchItem(a.id, { status: 'uploading' }, 'pending'), null, 'CAS refuses the wrong status');
    assert.equal((await store.patchItem(a.id, { status: 'uploading' }, 'queued')).status, 'uploading');
    assert.equal(await store.removeItem(a.id), false, 'in flight: not removable');
    assert.equal(await store.replaceImages(a.id, [png(9)]), null, 'in flight: images not replaceable');

    await store.patchItem(b.id, { status: 'blocked' });
    const again = await store.enqueue({ images: [png(4)], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'B2' });
    assert.equal(again.replaced, true, 'a stuck item on the node is replaced, not duplicated');
    assert.equal(again.item.id, b.id);
    assert.equal(await store.getImage(b.imageIds[0]), null, 'old images deleted');

    const staged = await store.stageImages([png(5)]);
    const c = await store.addItemWithImages({ imageIds: staged, assignmentId: ids.A1, nodeId: ids.A1n2, title: 'C' });
    assert.ok(c.order < again.item.order, 'replacement goes ahead of queued follow-ups');
    const orphan = await store.stageImages([png(6)]);

    await store.reorder([again.item.id, c.id, a.id]);
    db.close();

    db = openDb(file);
    store = makeStore(db);
    const list = await store.listBacklog();
    assert.deepEqual(list.map((i) => i.title), ['B', 'C', 'A'], 'order survives reopening (a replaced item keeps its title)');
    assert.equal(list.find((i) => i.id === a.id).status, 'uploading', 'status survives reopening');
    assert.equal(await store.gcImages(0, Date.now() + 1000), 1, 'only the unused staged image is collected');
    assert.equal(await store.hasImage(orphan[0]), false);
    assert.equal(await store.hasImage(staged[0]), true);
  } finally {
    try { db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engine on the SQLite store submits exactly once across many checks', async () => {
  const dir = tmp();
  try {
    const api = fakeServer(makeTerm());
    const { app, timers } = await readyApp(dir, api);
    await app.store.enqueue({ images: [png()], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'x' });
    for (let i = 0; i < 4; i++) { await app.tick(); timers.advance(60_000); }
    assert.equal(api.calls.post + api.calls.put, 1);
    const [it] = await app.store.listBacklog();
    assert.equal(it.status, 'pending');
    assert.ok(it.submissionId);
    await app.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 3: crashes -----------------------------------------------------------------

test('killed after the platform accepted the round: the restarted app counts it, no second write', async () => {
  const dir = tmp();
  try {
    const term = makeTerm();
    const api = fakeServer(term);
    let { app } = await readyApp(dir, api);
    await app.store.enqueue({ images: [png()], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'x' });
    // The round is created, then the response is lost (the process "dies" mid-request).
    api.onSubmit(async () => { throw new ApiError(0, null, 'TIMEOUT'); });
    assert.equal((await app.tick()).why, 'submitInDoubt');
    assert.equal((await app.store.listBacklog())[0].status, 'submitting');
    await app.stop();
    api.onSubmit(null);

    ({ app } = await readyApp(dir, api));
    await app.tick();
    await app.tick();
    assert.equal(api.calls.post + api.calls.put, 1, 'never sent again');
    assert.equal((await app.store.listBacklog())[0].status, 'pending');
    await app.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('killed before the platform saw the round: the restarted app sends it once', async () => {
  const dir = tmp();
  try {
    const term = makeTerm();
    const api = fakeServer(term);
    let { app } = await readyApp(dir, api);
    await app.store.enqueue({ images: [png()], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'x' });
    const realPost = api.createSubmission;
    api.createSubmission = async () => { throw new ApiError(0, null, 'TIMEOUT'); };
    await app.tick();
    await app.stop();
    api.createSubmission = realPost;

    ({ app } = await readyApp(dir, api));
    await app.tick(); // resolves the doubt: no round -> back to the queue
    await app.tick(); // sends it
    await app.tick();
    const a = term.weeks[0].lessons[0].assignments.find((x) => x.assignmentId === ids.A1);
    assert.equal(a.submissions.filter((s) => s.nodeId === ids.A1n2).length, 1, 'exactly one round');
    assert.equal((await app.store.listBacklog())[0].status, 'pending');
    await app.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 4: one instance -------------------------------------------------------------

test('a second instance exits with code 3 and does not touch the data', async () => {
  const dir = tmp();
  const blocker = createServer(() => {});
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  try {
    const main = fileURLToPath(new URL('../app/main.mjs', import.meta.url));
    const child = spawn(process.execPath, [main], { env: { ...process.env, CHAMBER_HOME: dir, CHAMBER_PORT: String(port) }, stdio: 'ignore' });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 3);
    assert.equal(existsSync(join(dir, 'chamber.sqlite')), false);
  } finally {
    blocker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 5: the local API --------------------------------------------------------------

function http(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(fn) {
  const dir = tmp();
  const api = fakeServer(makeTerm());
  api.login = async () => ({ token: jwt(Math.floor(Date.now() / 1000) + 86400), displayName: 'me' });
  const { app } = newApp(dir, { api });
  const server = makeServer(() => app, { port: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  // The Host check is against the configured port; rebuild with the real one.
  server.close();
  const real = makeServer(() => app, { port });
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  try {
    await fn({ app, port, host: `127.0.0.1:${port}` });
  } finally {
    real.close();
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('API: wrong Host, missing or wrong key, and preflights are refused without CORS headers', async () => {
  await withServer(async ({ app, port, host }) => {
    const call = (headers) => http(port, { method: 'POST', path: '/api/call/state', headers: { Host: host, 'Content-Type': 'application/json', ...headers }, body: '{}' });
    assert.equal((await call({ 'X-Chamber-Key': app.appKey })).status, 200);
    assert.equal((await call({ Host: `evil.example:${port}`, 'X-Chamber-Key': app.appKey })).status, 421, 'DNS rebinding');
    assert.equal((await call({})).status, 403, 'no key');
    assert.equal((await call({ 'X-Chamber-Key': 'nope' })).status, 403, 'wrong key');
    const pre = await http(port, {
      method: 'OPTIONS', path: '/api/call/state',
      headers: { Host: host, Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-chamber-key' },
    });
    assert.equal(pre.status, 403);
    assert.equal(Object.keys(pre.headers).some((h) => h.startsWith('access-control-')), false);
    const page = await http(port, { path: '/ui/options.html', headers: { Host: host } });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`<meta name="chamber-key" content="${app.appKey}">`), 'the page carries the key');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal((await http(port, { path: '/ui/../../package.json', headers: { Host: host } })).status, 404);
    assert.equal((await http(port, { path: '/node_modules/x', headers: { Host: host } })).status, 404);
  });
});

test('API: the password never appears in any response or the activity log', async () => {
  await withServer(async ({ app, port, host }) => {
    const call = async (name, payload = {}) => (await http(port, {
      method: 'POST', path: `/api/call/${name}`,
      headers: { Host: host, 'Content-Type': 'application/json', 'X-Chamber-Key': app.appKey }, body: JSON.stringify(payload),
    })).text;
    const outputs = [
      await call('saveLogin', { enabled: true, account: 'me@example.com', password: 'S3cret-pw' }),
      await call('loginStatus'), await call('state'), await call('audit'),
    ];
    for (const o of outputs) assert.equal(o.includes('S3cret-pw'), false, o);
    assert.equal(JSON.parse(outputs[1]).hasPassword, true);
  });
});

test('API: images are staged, served back, and given a thumbnail', async () => {
  await withServer(async ({ app, port, host }) => {
    const h = { Host: host, 'X-Chamber-Key': app.appKey };
    const up = await http(port, { method: 'POST', path: '/api/images', headers: { ...h, 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('画.png') }, body: Buffer.from([1, 2, 3]) });
    const { id } = JSON.parse(up.text);
    assert.equal((await http(port, { path: `/api/images/${id}/thumb`, headers: h })).status, 404);
    assert.equal((await http(port, { method: 'PUT', path: `/api/images/${id}/thumb`, headers: h, body: Buffer.from([9]) })).status, 200);
    assert.equal((await http(port, { path: `/api/images/${id}/thumb`, headers: h })).status, 200);
    assert.equal(app.store.imageBytes(id).name, '画.png');
    const res = await app.page.enqueue({ imageIds: [id], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'x', roundsAtQueue: 0 });
    assert.equal(res.ok, true);
    const twice = await app.page.enqueue({ imageIds: [id], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'x', roundsAtQueue: 0 });
    assert.equal(twice.error, 'reasonImageMissing', 'an image already on an item cannot be queued again');
  });
});

// ---- 6: session hand-over --------------------------------------------------------------

test('token hand-over keeps the longer-lasting token; the site session needs automatic login', async () => {
  const dir = tmp();
  try {
    const api = fakeServer(makeTerm());
    const now = Math.floor(Date.now() / 1000);
    api.login = async () => ({ token: jwt(now + 86400), displayName: 'me' });
    const { app } = newApp(dir, { api, now: () => Date.now() });
    const older = jwt(now + 3600);
    await app.site.token({ token: older });
    assert.equal(app.tokens.get(), older);
    await app.page.saveLogin({ enabled: true, account: 'a', password: 'p' });
    const fresh = app.tokens.get();
    assert.notEqual(fresh, older, 'automatic login got a newer token');
    await app.site.token({ token: older });
    assert.equal(app.tokens.get(), fresh, 'the page\'s older token does not replace it');
    assert.equal((await app.site.session()).token, fresh);
    await app.page.forgetLogin();
    assert.equal(await app.site.session(), null, 'no session given out without automatic login');
    await app.site.token({ token: jwt(now - 10) });
    assert.equal(app.tokens.get(), fresh, 'an expired page token is ignored');
    await app.site.token({ token: null });
    assert.equal(app.tokens.get(), null, 'logged out on the site, automatic login off: forgotten');
    await app.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 7: sleep ------------------------------------------------------------------------

test('a timer that fires a period late (sleep) checks at once, even outside review hours', async () => {
  const dir = tmp();
  try {
    const term = makeTerm();
    const api = fakeServer(term);
    // 01:00 Beijing: TAs are off duty.
    const timers = fakeTimers(Date.parse('2026-11-02T17:00:00Z'));
    const { app } = await readyApp(dir, api, { timers });
    await app.kv.setSettings({ reviewHoursOn: true });
    await app.start();
    await app.store.enqueue({ images: [png()], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'x' });

    timers.advance(60_000);
    await timers.fire(); // the start-up check and an on-time periodic one
    const after = api.calls.weeks;
    timers.advance(60_000);
    await timers.fire();
    assert.equal(api.calls.weeks, after, 'on time, off duty: no check');

    timers.advance(3 * 60 * 60_000); // asleep for three hours
    await timers.fire();
    assert.ok(api.calls.weeks > after, 'woke up: checked');
    assert.ok((await app.kv.getAudit()).some((e) => e.action === 'wake'));
    await app.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('notifications: approved and returned rounds raise a toast that opens the queue page', async () => {
  const dir = tmp();
  try {
    const term = makeTerm();
    const api = fakeServer(term);
    const shown = [];
    const { app } = await readyApp(dir, api, { notifier: { show: (n) => shown.push(n), clear() {} }, baseUrl: 'http://127.0.0.1:47815' });
    await app.store.enqueue({ images: [png()], assignmentId: ids.A1, nodeId: ids.A1n2, title: 'L7 node 2' });
    await app.tick();
    setStatus(term, ids.A1, ids.A1n2, 'APPROVED');
    await app.tick();
    await new Promise((r) => setTimeout(r, 20));
    const n = shown.find((x) => x.title === 'Approved');
    assert.ok(n, JSON.stringify(shown));
    assert.equal(n.body, 'L7 node 2');
    assert.equal(n.url, 'http://127.0.0.1:47815/');
    await app.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settings from the page cannot touch internal fields', async () => {
  const dir = tmp();
  try {
    const { app } = newApp(dir, { api: fakeServer(makeTerm()) });
    const next = await app.page.settings({ patch: { dryRun: false, autoLogin: true, sessionInvalid: true } });
    assert.equal(next.dryRun, false);
    assert.equal(next.autoLogin, false);
    assert.equal(next.sessionInvalid, false);
    await app.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kv: the activity log keeps the last 200 entries', async () => {
  const kv = makeKv(openDb(':memory:'));
  for (let i = 0; i < 230; i++) await kv.appendAudit({ action: 'x', n: i });
  const log = await kv.getAudit();
  assert.equal(log.length, 200);
  assert.equal(log[0].n, 30);
});
