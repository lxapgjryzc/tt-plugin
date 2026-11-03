import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../app/src/db.js';
import { makeKv, KEYS } from '../app/src/kv.js';
import { makeTokens } from '../app/src/tokens.js';
import { makeAutoLogin, RETRY_AFTER_MS } from '../app/src/auto-login.js';
import { ApiError, makeApi } from '../app/src/adapter.js';
import { target } from './target.mock.js';

// Stand-in for DPAPI: reversible, but never the plain text.
const secret = {
  protect: async (t) => `enc:${Buffer.from(t).toString('base64')}`,
  unprotect: async (c) => Buffer.from(c.slice(4), 'base64').toString(),
};

let kv;
let login;
let tryAutoLogin;
let saveLogin;
let forgetLogin;
let loginStatus;
let autoLoginActive;
let getSettings;
let getAudit;
const mem = new Proxy({}, { get: (_t, k) => kv.get(k) });

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (exp) => `${b64url({ alg: 'HS512' })}.${b64url({ sub: '1', exp })}.sig`;
const freshToken = () => jwt(Math.floor(Date.now() / 1000) + 24 * 3600);

function fakeApi(behaviour) {
  const calls = [];
  return {
    calls,
    async login(account, password) {
      calls.push({ account, password });
      return behaviour(account, password);
    },
  };
}
const okApi = () => fakeApi(() => ({ token: freshToken(), userId: '9', displayName: 'me', roles: ['STUDENT'], passwordSet: true }));

beforeEach(() => {
  kv = makeKv(openDb(':memory:'));
  login = makeAutoLogin({ kv, secret, tokens: makeTokens(kv) });
  ({ saveLogin, forgetLogin, loginStatus, autoLoginActive } = login);
  tryAutoLogin = login.tryAutoLogin;
  ({ getSettings, getAudit } = kv);
});

test('off by default: no login attempt', async () => {
  const api = okApi();
  assert.equal((await getSettings()).autoLogin, false);
  assert.equal(await tryAutoLogin(api), null);
  assert.equal(api.calls.length, 0);
});

test('logs in with the saved credentials and keeps the session for the site', async () => {
  const api = okApi();
  await saveLogin({ enabled: true, account: ' 13800000000 ', password: 'pw1' });
  const token = await tryAutoLogin(api);
  assert.ok(token);
  assert.deepEqual(api.calls, [{ account: '13800000000', password: 'pw1' }]);
  assert.equal(mem[KEYS.token], token);
  assert.equal(mem[KEYS.siteSession].token, token);
  assert.equal(mem[KEYS.siteSession].displayName, 'me');
  assert.equal(await autoLoginActive(), true);
  const status = await loginStatus();
  assert.equal(status.ok, true);
  assert.equal(JSON.stringify(status).includes('pw1'), false, 'status never carries the password');
  assert.equal(JSON.stringify(await getAudit()).includes('pw1'), false, 'audit never carries the password');
});

test('refused credentials are never retried until changed', async () => {
  const api = fakeApi(() => { throw new ApiError(200, 400, '账号或密码错误'); });
  await saveLogin({ enabled: true, account: 'a', password: 'wrong' });
  assert.equal(await tryAutoLogin(api, { force: true }), null);
  const status = await loginStatus();
  assert.equal(status.rejected, true);
  assert.equal(status.error, '账号或密码错误');
  assert.equal(await autoLoginActive(), false);
  // even forced, and long after
  assert.equal(await tryAutoLogin(api, { force: true, now: Date.now() + 10 * RETRY_AFTER_MS }), null);
  assert.equal(api.calls.length, 1);
  // a new password clears it
  await saveLogin({ enabled: true, account: 'a', password: 'right' });
  await tryAutoLogin(api);
  assert.equal(api.calls.length, 2);
});

test('network failures retry, but not more than every 10 minutes', async () => {
  let fail = true;
  const api = fakeApi(() => {
    if (fail) throw new ApiError(0, null, 'TIMEOUT');
    return { token: freshToken() };
  });
  await saveLogin({ enabled: true, account: 'a', password: 'p' });
  const t0 = Date.now();
  assert.equal(await tryAutoLogin(api, { now: t0 }), null);
  assert.equal((await loginStatus()).rejected, false);
  assert.equal(await tryAutoLogin(api, { now: t0 + 60_000 }), null);
  assert.equal(api.calls.length, 1, 'rate limited');
  fail = false;
  assert.ok(await tryAutoLogin(api, { now: t0 + RETRY_AFTER_MS + 1 }));
  assert.equal(api.calls.length, 2);
});

test('an empty password field keeps the saved password for the same account', async () => {
  await saveLogin({ enabled: true, account: 'a', password: 'secret' });
  await saveLogin({ enabled: false, account: 'a', password: '' });
  assert.equal(await secret.unprotect(mem[KEYS.credentials].passwordEnc), 'secret');
  assert.equal((await getSettings()).autoLogin, false);
  await saveLogin({ enabled: true, account: 'b', password: '' });
  assert.equal(mem[KEYS.credentials].passwordEnc, '', 'a different account does not inherit it');
  assert.equal((await loginStatus()).hasPassword, false);
});

test('forget removes the credentials and the site session', async () => {
  await saveLogin({ enabled: true, account: 'a', password: 'p' });
  await tryAutoLogin(okApi());
  await forgetLogin();
  assert.equal(mem[KEYS.credentials], undefined);
  assert.equal(mem[KEYS.siteSession], undefined);
  assert.equal((await getSettings()).autoLogin, false);
});

test('login request goes to the password endpoint without an Authorization header', async () => {
  let seen;
  const api = makeApi(target, {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ code: 0, message: 'ok', data: { token: 'x' } }) };
    },
  });
  const data = await api.login('a', 'p');
  assert.equal(data.token, 'x');
  assert.equal(seen.url, 'https://mock.invalid/api/auth/password/login');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(seen.init.body), { account: 'a', password: 'p' });
});

test('the password is stored only encrypted, and nothing is saved when encryption fails', async () => {
  await saveLogin({ enabled: true, account: 'a', password: 'hunter2' });
  assert.equal(JSON.stringify(mem[KEYS.credentials]).includes('hunter2'), false);
  const broken = makeAutoLogin({ kv, secret: { protect: async () => { throw new Error('no DPAPI'); } }, tokens: makeTokens(kv) });
  const res = await broken.saveLogin({ enabled: true, account: 'b', password: 'other' });
  assert.deepEqual(res, { saved: false, reason: 'passwordNoEncryption' });
  assert.equal(mem[KEYS.credentials].account, 'a', 'previous credentials untouched');
  assert.equal(JSON.stringify(await broken.loginStatus()).includes('other'), false);
});
