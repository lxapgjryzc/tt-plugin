import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseServerTime, assignmentExpired } from '../extension/src/model.js';

test('server times are read as Beijing time', () => {
  assert.equal(new Date(parseServerTime('2026-10-27T12:45:44')).toISOString(), '2026-10-27T04:45:44.000Z');
  assert.equal(new Date(parseServerTime('2026-10-27T12:45:44+08:00')).toISOString(), '2026-10-27T04:45:44.000Z');
  assert.ok(Number.isNaN(parseServerTime(null)));
});

test('deadline check does not depend on the browser timezone', () => {
  const a = { status: 'PUBLISHED', deadline: '2026-12-05T23:59:26' };
  assert.equal(assignmentExpired(a, null, Date.parse('2026-12-05T15:59:00Z')), false);
  assert.equal(assignmentExpired(a, null, Date.parse('2026-12-05T16:00:00Z')), true);
});

// Runs the page patch in a fresh Node process pinned to a non-UTC+8 timezone.
function runPatched(tz, code) {
  const script = fileURLToPath(new URL('../extension/src/content/tz-fix.js', import.meta.url));
  const prog = `
    globalThis.window = globalThis;
    require(${JSON.stringify(script)});
    ${code}
  `;
  const r = spawnSync(process.execPath, ['-e', prog], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('tz-fix: naive strings become +08:00 in Los Angeles; everything else untouched', () => {
  const out = runPatched('America/Los_Angeles', `
    console.log(JSON.stringify({
      naive: new Date('2026-10-27T12:45:44').toISOString(),
      space: new Date('2026-10-27 12:45').toISOString(),
      nanos: new Date('2026-10-27T12:45:44.264932473').toISOString(),
      parse: Date.parse('2026-10-27T12:45:44'),
      zulu: new Date('2026-10-27T12:45:44Z').toISOString(),
      offset: new Date('2026-10-27T12:45:44-07:00').toISOString(),
      dateOnly: new Date('2026-10-27').toISOString(),
      parts: new Date(2026, 9, 27, 12).getHours(),
      num: new Date(0).toISOString(),
      inst: new Date() instanceof Date,
      call: typeof Date(),
      now: typeof Date.now(),
    }));
  `);
  assert.equal(out.naive, '2026-10-27T04:45:44.000Z');
  assert.equal(out.space, '2026-10-27T04:45:00.000Z');
  assert.equal(out.nanos, '2026-10-27T04:45:44.264Z');
  assert.equal(out.parse, Date.parse('2026-10-27T04:45:44Z'));
  assert.equal(out.zulu, '2026-10-27T12:45:44.000Z');
  assert.equal(out.offset, '2026-10-27T19:45:44.000Z');
  assert.equal(out.dateOnly, '2026-10-27T00:00:00.000Z');
  assert.equal(out.parts, 12);
  assert.equal(out.num, '1970-01-01T00:00:00.000Z');
  assert.equal(out.inst, true);
  assert.equal(out.call, 'string');
  assert.equal(out.now, 'number');
});

test('tz-fix: no-op when the browser is already UTC+8', () => {
  const out = runPatched('Asia/Shanghai', `console.log(JSON.stringify({ patched: Date.name !== 'Date' }));`);
  assert.equal(out.patched, false);
});
