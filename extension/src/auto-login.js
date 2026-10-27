// Optional automatic login (off by default).
//
// The site's session token lives 24 h and cannot be refreshed; the only way to keep
// going is to log in again. When the user turns this on and saves their account and
// password, the extension calls the site's password login (no captcha on that
// endpoint) whenever the token is missing, expired or about to expire.
//
// The password is kept in chrome.storage.local, unencrypted, readable only by this
// extension, and is only ever sent to the site's login endpoint over HTTPS. It is
// never written to the activity log or exposed to content scripts.

import { KEYS, getSettings, setSettings, appendAudit } from './storage/settings.js';
import { storeToken, usable } from './token-bridge.js';
import { siteSessionFrom } from './session.js';

// After a failed attempt (or a 401 right after a login), wait this long before trying again.
export const RETRY_AFTER_MS = 10 * 60_000;

async function fingerprint(account, password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${account}\u0000${password}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readState() {
  const got = await chrome.storage.local.get([KEYS.credentials, KEYS.autoLoginState]);
  const c = got[KEYS.credentials];
  return { credentials: c?.account && c?.password ? c : null, state: got[KEYS.autoLoginState] || null };
}

// What the settings page may see: never the password itself.
export async function loginStatus() {
  const [{ credentials, state }, s] = await Promise.all([readState(), getSettings()]);
  const raw = (await chrome.storage.local.get(KEYS.credentials))[KEYS.credentials];
  return {
    enabled: s.autoLogin,
    account: raw?.account || '',
    hasPassword: !!credentials,
    ok: state?.ok ?? null,
    at: state?.at ?? null,
    error: state?.ok === false ? state.error : null,
    rejected: !!state?.rejected,
  };
}

// Is automatic login set up and not stopped by a refused password or a recent failure?
export async function autoLoginActive() {
  const [{ credentials, state }, s] = await Promise.all([readState(), getSettings()]);
  return !!(s.autoLogin && credentials && !(state && state.ok === false));
}

export async function saveLogin({ enabled, account, password }) {
  const { [KEYS.credentials]: cur } = await chrome.storage.local.get(KEYS.credentials);
  const acc = String(account ?? '').trim();
  // An empty password field means "keep the saved one" (only for the same account).
  const pw = password ? String(password) : (cur?.account === acc ? cur?.password : '');
  await chrome.storage.local.set({ [KEYS.credentials]: { account: acc, password: pw || '' } });
  await chrome.storage.local.remove(KEYS.autoLoginState);
  await setSettings({ autoLogin: !!enabled });
}

export async function forgetLogin() {
  await chrome.storage.local.remove([KEYS.credentials, KEYS.autoLoginState, KEYS.siteSession]);
  await setSettings({ autoLogin: false });
}

/**
 * Log in with the saved credentials. Returns the new token, or null if automatic
 * login is off, not set up, rate-limited, or failed. `force` skips the rate limit
 * (the user just saved or asked for it).
 */
export async function tryAutoLogin(api, { force = false, now = Date.now() } = {}) {
  const s = await getSettings();
  if (!s.autoLogin) return null;
  const { credentials, state } = await readState();
  if (!credentials) return null;
  const fp = await fingerprint(credentials.account, credentials.password);
  // These exact credentials were refused: retrying could get the account locked.
  if (state?.rejected === fp) return null;
  if (!force && state?.lastTryAt && now - state.lastTryAt < RETRY_AFTER_MS) return null;

  try {
    const data = await api.login(credentials.account, credentials.password);
    if (!usable(data?.token)) throw new Error('NO_TOKEN_IN_RESPONSE');
    await storeToken(data.token);
    await chrome.storage.local.set({
      [KEYS.siteSession]: siteSessionFrom(data),
      [KEYS.autoLoginState]: { ok: true, at: now, lastTryAt: now },
    });
    if (s.sessionInvalid) await setSettings({ sessionInvalid: false });
    await appendAudit({ action: 'login', result: 'ok' });
    return data.token;
  } catch (e) {
    // A business error or a 4xx means the platform refused these credentials; a
    // network error, timeout or 5xx is worth another try later.
    const refused = typeof e?.status === 'number' && e.status !== 0 && !e.retryable;
    await chrome.storage.local.set({
      [KEYS.autoLoginState]: { ok: false, at: now, lastTryAt: now, error: e?.message || String(e), rejected: refused ? fp : null },
    });
    await appendAudit({ action: 'login', result: 'error', message: e?.message || String(e) });
    return null;
  }
}
