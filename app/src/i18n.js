// Message lookup with a user-selectable language. Shared by the queue page (browser) and
// the app (Node, for notifications); each passes in how to read _locales/<lang>/messages.json.
// 'auto' follows the language of whoever shows the text: the browser for pages, the
// Windows display language for notifications (requirements R9.14).
// Content injected into tenten.art always uses PAGE_LOCALE (the site is Chinese-only).

export const LOCALES = ['auto', 'en', 'zh_CN'];
export const PAGE_LOCALE = 'zh_CN';

// The _locales folder to use for a setting and a BCP 47 language tag (e.g. 'zh-CN').
export function resolveLocale(locale, lang) {
  if (locale && locale !== 'auto' && LOCALES.includes(locale)) return locale;
  return /^zh\b/i.test(String(lang || '')) ? 'zh_CN' : 'en';
}

// `read(locale)` resolves with the parsed messages.json. Falls back to English.
export async function loadMessages(locale, lang, read) {
  const want = resolveLocale(locale, lang);
  try {
    return await read(want);
  } catch {
    return want === 'en' ? null : read('en').catch(() => null);
  }
}

export function format(messages, key, subs) {
  const entry = messages?.[key];
  if (!entry) return key;
  const list = [].concat(subs ?? []).map(String);
  return entry.message.replace(/\$P(\d)\$/g, (_, n) => list[Number(n) - 1] ?? '');
}

// The language actually in effect, for <html lang> and Intl formatting.
export function effectiveLocale(locale, lang) {
  return resolveLocale(locale, lang).replace('_', '-');
}
