// Service worker of the thin extension (requirements R9.16-R9.20). It holds no queue and
// never calls the platform: it relays the site page's requests to the Chamber app on this
// computer, shows the app's state on the toolbar icon, and opens the queue page.

const APP = 'http://127.0.0.1:47815';
const KEY = 'chamber:appKey';
const ALARM = 'chamber:badge';
const PAGE_LOCALE = 'zh_CN'; // tenten.art is Chinese-only

class AppError extends Error {}

async function call(area, name, payload = {}) {
  const { [KEY]: key } = await chrome.storage.local.get(KEY);
  if (!key) throw new AppError('appNotPaired');
  let res;
  try {
    res = await fetch(`${APP}/api/${area}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chamber-Key': key },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new AppError('appUnreachable');
  }
  if (res.status === 403) throw new AppError('appNotPaired'); // the app's key changed
  if (!res.ok) throw new AppError('appUnreachable');
  return res.json();
}

// ---- toolbar badge (R9.19) ------------------------------------------------
async function refreshBadge() {
  let text = 'off';
  let color = '#8a8a86';
  try {
    const b = await call('site', 'badge');
    text = b.text;
    color = b.alert ? '#c2410c' : '#1c1c1c';
  } catch { /* not running or not paired */ }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

async function openQueue(query = '') {
  const url = `${APP}/${query}`;
  const tabs = await chrome.tabs.query({ url: [`${APP}/*`, 'http://localhost:47815/*'] });
  const [tab] = tabs;
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true, ...(query ? { url } : {}) });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(() => {
  openQueue();
  call('site', 'pageNav').catch(() => {}); // check right away
});

// ---- messages from content scripts -------------------------------------------
const fromSite = (sender) => sender.id === chrome.runtime.id && sender.url?.startsWith('https://tenten.art/');
const fromApp = (sender) => sender.id === chrome.runtime.id
  && (sender.url?.startsWith(`${APP}/`) || sender.url?.startsWith('http://localhost:47815/'));

let strings = null;
async function pageStrings() {
  if (!strings) strings = await (await fetch(chrome.runtime.getURL(`_locales/${PAGE_LOCALE}/messages.json`))).json();
  return strings;
}

const handlers = {
  'chamber:pair': async ({ key }, sender) => {
    if (!fromApp(sender) || typeof key !== 'string' || !key) return { ok: false };
    await chrome.storage.local.set({ [KEY]: key });
    await refreshBadge();
    return { ok: true };
  },
  'chamber:pageStrings': () => pageStrings(),
  'chamber:token': async ({ token }, sender) => (fromSite(sender) ? call('site', 'token', { token: token || null }) : null),
  'chamber:siteSession': async (_m, sender) => (fromSite(sender) ? call('site', 'session') : null),
  'chamber:lookup': async ({ assignmentId }) => call('site', 'lookup', { assignmentId }),
  'chamber:badgeInfo': async () => call('site', 'badge'),
  'chamber:pageNav': async () => call('site', 'pageNav'),
  'chamber:openQueue': async ({ query }) => { await openQueue(query || ''); return { ok: true }; },
  'chamber:enqueue': async ({ where, images }, sender) => {
    if (!fromSite(sender)) return { error: 'reasonAssignmentMissing' };
    const res = await call('site', 'enqueue', { where, images });
    refreshBadge();
    return res;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h(msg, sender)).then(reply, (e) => reply({ error: e instanceof AppError ? e.message : (e?.message || String(e)) }));
  return true;
});

// ---- install / update ----------------------------------------------------------
// Earlier versions kept the whole queue, images and the saved password in Chrome. None
// of it is carried over (R9.20): delete it, keeping only the pairing key.
async function dropOldData() {
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k !== KEY);
  if (old.length) await chrome.storage.local.remove(old);
  await chrome.storage.session?.clear?.();
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('chamber');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await dropOldData().catch(() => {});
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  refreshBadge();
});
chrome.runtime.onStartup.addListener(() => refreshBadge());
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) refreshBadge(); });
refreshBadge().catch(() => {});
