// Bearer token acquisition.
// 1. The content script pushes the token into chrome.storage.session whenever a
//    tenten.art page loads, so ticks keep working after the tab is closed.
// 2. If asked for a fresh token (after a 401) or nothing is cached, read it straight
//    from an open tab via chrome.scripting.

import { target } from './target.js';
import { KEYS } from './storage/settings.js';

const CACHE_MS = 30_000;
let mem = { token: null, at: 0 };

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
  if (token) await chrome.storage.session.set({ [KEYS.token]: token });
  else await chrome.storage.session.remove(KEYS.token);
}

export async function getToken({ fresh = false } = {}) {
  if (!fresh && mem.token && Date.now() - mem.at < CACHE_MS) return mem.token;
  const live = await readFromTab();
  if (live) {
    await storeToken(live);
    return live;
  }
  if (fresh) return null;
  const { [KEYS.token]: cached } = await chrome.storage.session.get(KEYS.token);
  if (cached) mem = { token: cached, at: Date.now() };
  return cached || null;
}
