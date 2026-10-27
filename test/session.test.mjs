import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenExpiry, sessionState, EXPIRING_SOON_MS } from '../extension/src/session.js';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload) => `${b64url({ alg: 'HS512' })}.${b64url(payload)}.sig`;

test('tokenExpiry reads exp from a JWT', () => {
  assert.equal(tokenExpiry(jwt({ sub: '1', exp: 1_800_000_000 })), 1_800_000_000_000);
  assert.equal(tokenExpiry(jwt({ sub: '1' })), null);
  assert.equal(tokenExpiry('not-a-jwt'), null);
  assert.equal(tokenExpiry(null), null);
  // payload whose base64 needs padding and contains url-safe characters
  assert.equal(tokenExpiry(jwt({ displayName: '712-0.9-求严~~', exp: 1_800_000_001 })), 1_800_000_001_000);
});

test('sessionState', () => {
  const now = 1_800_000_000_000;
  const tok = (ms) => jwt({ exp: Math.floor((now + ms) / 1000) });
  assert.equal(sessionState({ token: tok(5 * 3600_000) }, now), 'ok');
  assert.equal(sessionState({ token: tok(EXPIRING_SOON_MS - 60_000) }, now), 'expiring');
  assert.equal(sessionState({ token: tok(-1000) }, now), 'expired');
  assert.equal(sessionState({ token: null }, now), 'missing');
  assert.equal(sessionState({ token: tok(5 * 3600_000), sessionInvalid: true }, now), 'invalid');
  assert.equal(sessionState({ token: 'opaque' }, now), 'ok');
});
