// chrome.storage wrappers. Keys are prefixed `chamber:`.

export const KEYS = {
  settings: 'chamber:settings',
  audit: 'chamber:audit',
  lock: 'chamber:lock',
  snapshot: 'chamber:snapshot', // last term summary for the popup (local, small)
  token: 'chamber:token', // session storage only
  lastTick: 'chamber:lastTick',
};

export const DEFAULTS = {
  activeTermId: null,
  paused: false,
  autoSubmit: false,
  dryRun: true,
  tickSeconds: 60,
  sessionInvalid: false,
  locale: 'auto', // 'auto' follows the browser; or 'en' / 'zh_CN'
};

export const MIN_TICK = 30;
const AUDIT_MAX = 200;

export async function getSettings() {
  const { [KEYS.settings]: s } = await chrome.storage.local.get(KEYS.settings);
  return { ...DEFAULTS, ...(s || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  next.tickSeconds = Math.max(MIN_TICK, Math.round(Number(next.tickSeconds) || DEFAULTS.tickSeconds));
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}

export async function appendAudit(entry) {
  const { [KEYS.audit]: log = [] } = await chrome.storage.local.get(KEYS.audit);
  log.push({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ [KEYS.audit]: log.slice(-AUDIT_MAX) });
}

export async function getAudit() {
  const { [KEYS.audit]: log = [] } = await chrome.storage.local.get(KEYS.audit);
  return log;
}

// Single-flight tick lock in chrome.storage.session. It survives service-worker
// eviction (session storage lives as long as the browser), so a tick that died
// mid-flight keeps the lock until it goes stale.
export const LOCK_TTL_MS = 3 * 60_000;

export async function acquireLock(owner, now = Date.now()) {
  const { [KEYS.lock]: cur } = await chrome.storage.session.get(KEYS.lock);
  if (cur && now - cur.at < LOCK_TTL_MS) return false;
  await chrome.storage.session.set({ [KEYS.lock]: { owner, at: now } });
  // Read back: if another context raced us, the last writer wins and the other backs off.
  const { [KEYS.lock]: check } = await chrome.storage.session.get(KEYS.lock);
  return check?.owner === owner;
}

export async function refreshLock(owner) {
  const { [KEYS.lock]: cur } = await chrome.storage.session.get(KEYS.lock);
  if (cur?.owner !== owner) return false;
  await chrome.storage.session.set({ [KEYS.lock]: { owner, at: Date.now() } });
  return true;
}

export async function releaseLock(owner) {
  const { [KEYS.lock]: cur } = await chrome.storage.session.get(KEYS.lock);
  if (cur?.owner === owner) await chrome.storage.session.remove(KEYS.lock);
}
