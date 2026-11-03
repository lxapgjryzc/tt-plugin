import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveLocale, loadMessages, format } from '../app/src/i18n.js';

const repo = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, repo), 'utf8');
const en = JSON.parse(read('app/_locales/en/messages.json'));
const zh = JSON.parse(read('app/_locales/zh_CN/messages.json'));

function usedKeys() {
  const files = [
    ...readdirSync(new URL('app/ui/', repo)).map((f) => `app/ui/${f}`),
    ...readdirSync(new URL('app/src/', repo)).filter((f) => f.endsWith('.js')).map((f) => `app/src/${f}`),
    'extension/src/background.js',
    'extension/src/content/homework-badge.js',
  ];
  const keys = new Set();
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/\bt\('([A-Za-z_]+)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/getMessage\('([A-Za-z_]+)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/format\(m(?:essages)?, '([A-Za-z_]+)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z_]+)"/g)) keys.add(m[1]);
    // reason / wait / status / app keys passed around as values
    for (const m of s.matchAll(/'((?:reason|wait|st|ns|type|hint|err|mode|app|notify)[A-Z][A-Za-z]*)'/g)) keys.add(m[1]);
  }
  for (const m of read('app/src/scheduler.js').matchAll(/why: '([A-Za-z]+)'/g)) keys.add(`why_${m[1]}`);
  for (const m of read('app/src/engine.js').matchAll(/why: '([A-Za-z]+)'/g)) keys.add(`why_${m[1]}`);
  keys.delete('modeHint'); // an element id, not a message
  keys.delete('appKey'); // a storage key, not a message
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

test('the app and the extension ship the same generated strings', () => {
  for (const lang of ['en', 'zh_CN']) {
    assert.equal(read(`extension/_locales/${lang}/messages.json`), read(`app/_locales/${lang}/messages.json`));
  }
});

test('manifest resolves its name through _locales with default_locale en', () => {
  const m = JSON.parse(read('extension/manifest.json'));
  assert.equal(m.name, '__MSG_extName__');
  assert.equal(m.default_locale, 'en');
  assert.equal(en.extName.message, 'Chamber');
  assert.equal(zh.extName.message, 'Chamber 作业排队');
});

test('auto follows the viewer language; an explicit choice wins', async () => {
  assert.equal(resolveLocale('auto', 'zh-CN'), 'zh_CN');
  assert.equal(resolveLocale('auto', 'zh-Hans-CN'), 'zh_CN');
  assert.equal(resolveLocale('auto', 'en-US'), 'en');
  assert.equal(resolveLocale('auto', 'de-DE'), 'en');
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('zh_CN', 'en-US'), 'zh_CN');
  const read2 = async (l) => ({ en, zh_CN: zh })[l];
  const m = await loadMessages('auto', 'zh-CN', read2);
  assert.equal(format(m, 'slotsFree', ['1', '2']), '空闲名额 1 / 2');
  assert.equal(format(m, 'noSuchKey'), 'noSuchKey');
});
