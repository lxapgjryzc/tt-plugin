// Writes _locales/{en,zh_CN}/messages.json from tools/locales.src.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import rows from './locales.src.mjs';

const toMsg = (text) => {
  const placeholders = {};
  const message = text.replace(/\$(\d)/g, (_, n) => {
    placeholders[`p${n}`] = { content: `$${n}` };
    return `$P${n}$`;
  });
  return Object.keys(placeholders).length ? { message, placeholders } : { message };
};

const seen = new Set();
for (const [key] of rows) {
  if (seen.has(key)) throw new Error(`duplicate key ${key}`);
  seen.add(key);
}
for (const [i, lang] of [[1, 'en'], [2, 'zh_CN']]) {
  const out = Object.fromEntries(rows.map((r) => [r[0], toMsg(r[i])]));
  const dir = new URL(`../extension/_locales/${lang}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('messages.json', dir), `${JSON.stringify(out, null, 2)}\n`);
}
