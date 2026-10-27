import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../extension/', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const en = JSON.parse(read('_locales/en/messages.json'));
const zh = JSON.parse(read('_locales/zh_CN/messages.json'));

function usedKeys() {
  const files = [
    ...readdirSync(new URL('ui/', root)).map((f) => `ui/${f}`),
    ...readdirSync(new URL('src/', root)).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
    'src/content/homework-badge.js',
  ];
  const keys = new Set();
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/\bt\('([A-Za-z_]+)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/getMessage\('([A-Za-z_]+)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z_]+)"/g)) keys.add(m[1]);
    // reason / wait / status keys passed around as values
    for (const m of s.matchAll(/'((?:reason|wait|st|ns|type|hint|err|mode)[A-Z][A-Za-z]*)'/g)) keys.add(m[1]);
  }
  for (const m of read('src/scheduler.js').matchAll(/why: '([A-Za-z]+)'/g)) keys.add(`why_${m[1]}`);
  for (const m of read('src/engine.js').matchAll(/why: '([A-Za-z]+)'/g)) keys.add(`why_${m[1]}`);
  keys.delete('modeHint'); // an element id, not a message
  return keys;
}

const ENGINE_ONLY = new Set(['why_locked', 'why_dryRun', 'why_imageMissing', 'why_tooLarge', 'why_uploadError', 'why_raced', 'why_submitInDoubt', 'why_rejected', 'why_submitted']);

test('every message used in code exists in both locales', () => {
  const missing = [...usedKeys()].filter((k) => !ENGINE_ONLY.has(k) && (!en[k] || !zh[k]));
  assert.deepEqual(missing, []);
});

test('en and zh_CN have the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test('manifest resolves its name through _locales with default_locale en', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.name, '__MSG_extName__');
  assert.equal(m.default_locale, 'en');
  assert.equal(en.extName.message, 'Chamber');
  assert.equal(zh.extName.message, 'Chamber 作业排队');
});
