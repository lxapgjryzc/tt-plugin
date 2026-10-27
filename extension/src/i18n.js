// Message lookup with a user-selectable language.
//
// chrome.i18n always follows the browser's UI language, so the extension loads the
// chosen _locales/<lang>/messages.json itself. 'auto' falls back to chrome.i18n.
// Content injected into tenten.art always uses PAGE_LOCALE (the site is Chinese-only).

export const LOCALES = ['auto', 'en', 'zh_CN'];
export const PAGE_LOCALE = 'zh_CN';

export async function loadMessages(locale) {
  if (!locale || locale === 'auto') return null;
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
    return await res.json();
  } catch {
    return null;
  }
}

export function format(messages, key, subs) {
  const entry = messages?.[key];
  if (!entry) return chrome.i18n.getMessage(key, subs) || key;
  const list = [].concat(subs ?? []).map(String);
  return entry.message.replace(/\$P(\d)\$/g, (_, n) => list[Number(n) - 1] ?? '');
}

// The language actually in effect, for <html lang> and Intl formatting.
export function effectiveLocale(locale) {
  return !locale || locale === 'auto' ? chrome.i18n.getUILanguage() : locale.replace('_', '-');
}
