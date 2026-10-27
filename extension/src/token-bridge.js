// Bearer token acquisition.
// 1. The content script pushes the token into chrome.storage.local whenever a
//    tenten.art page loads, so checks keep working after the tab is closed and after a
//    browser restart. The site itself keeps the same token in its localStorage, so
//    this adds no exposure; logging out on the site clears our copy too.
// 2. If asked for a fresh token (after a 401) or nothing is stored, read it straight
//    from an open tab via chrome.scripting.

import { target } from './target.js';
import { KEYS } from './storage/settings.js';
import { tokenExpiry } from './session.js';

const CACHE_MS = 30_000;
let mem = { token: null, at: 0 };

// A token we can still use: not past its JWT expiry (tokens without one are trusted).
export function usable(token) {
  if (!token) return false;
  const exp = tokenExpiry(token);
  return exp === null || exp > Date.now();
}

async function readFromTab() {
  const tabs = await chrome.tabs.query({ url: `${target.base}/*` });
  for (const tab of tabs) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (key, field) => {
          try { return JSON.parse(localStorage.getItem(key) || 'null')?.[field] || null; } catch { return null; }
        },
        args: [target.authStorageKey, target.authTokenPath],
      });
      if (res?.result) return res.result;
    } catch {
      /* tab not scriptable (discarded, loading); try the next */
    }
  }
  return null;
}

export async function storeToken(token) {
  mem = { token: token || null, at: Date.now() };
  if (token) await chrome.storage.local.set({ [KEYS.token]: token });
  else await chrome.storage.local.remove(KEYS.token);
}

// `fresh` skips the in-memory cache (used after the server rejected a token; the
// rejected one has already been dropped from storage by then).
export async function getToken({ fresh = false } = {}) {
  if (!fresh && usable(mem.token) && Date.now() - mem.at < CACHE_MS) return mem.token;
  const live = await readFromTab();
  if (usable(live)) {
    await storeToken(live);
    return live;
  }
  const { [KEYS.token]: stored } = await chrome.storage.local.get(KEYS.token);
  if (!usable(stored)) return null;
  mem = { token: stored, at: Date.now() };
  return stored;
}
