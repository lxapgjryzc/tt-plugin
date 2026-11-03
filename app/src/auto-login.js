// Optional automatic login (off by default).
//
// The site's session token lives 24 h and cannot be refreshed; the only way to keep
// going is to log in again. When the user turns this on and saves their account and
// password, the app calls the site's password login (no captcha on that endpoint)
// whenever the token is missing, expired or about to expire.
//
// The password is encrypted with Windows DPAPI before it is stored (requirements R9.9);
// `secret` is { protect(text), unprotect(cipher) } and throws when that is unavailable,
// in which case nothing is saved. The password is never logged, never returned to the
// page, and only ever sent to the site's login endpoint over HTTPS.

import { createHash } from 'node:crypto';
import { KEYS } from './kv.js';
import { siteSessionFrom, usable } from './session.js';

// After a failed attempt (or a 401 right after a login), wait this long before trying again.
export const RETRY_AFTER_MS = 10 * 60_000;

const fingerprint = (account, password) => createHash('sha256').update(`${account}\u0000${password}`).digest('hex');

export function makeAutoLogin({ kv, secret, tokens }) {
  const creds = () => {
    const c = kv.get(KEYS.credentials);
    return c?.account ? c : null;
  };
  const state = () => kv.get(KEYS.autoLoginState) || null;

  async function password() {
    const c = creds();
    if (!c?.passwordEnc) return null;
    return secret.unprotect(c.passwordEnc);
  }

  const api = {
    // What the queue page may see: never the password itself.
    async loginStatus() {
      const [c, st, s] = [creds(), state(), await kv.getSettings()];
      return {
        enabled: s.autoLogin,
        account: c?.account || '',
        hasPassword: !!c?.passwordEnc,
        ok: st?.ok ?? null,
        at: st?.at ?? null,
        error: st?.ok === false ? st.error : null,
        rejected: !!st?.rejected,
        saveError: st?.saveError ?? null,
      };
    },

    // Is automatic login set up and not stopped by a refused password or a recent failure?
    async autoLoginActive() {
      const [c, st, s] = [creds(), state(), await kv.getSettings()];
      return !!(s.autoLogin && c?.passwordEnc && !(st && st.ok === false));
    },

    // An empty password field means "keep the saved one" (only for the same account).
    // Resolves with { saved } ; { saved: false, reason } when the password could not be
    // encrypted (then nothing changes).
    async saveLogin({ enabled, account, password: pw }) {
      const cur = creds();
      const acc = String(account ?? '').trim();
      let passwordEnc = '';
      if (pw) {
        try {
          passwordEnc = await secret.protect(String(pw));
        } catch (e) {
          kv.set(KEYS.autoLoginState, { ...(state() || {}), saveError: e?.message || String(e) });
          return { saved: false, reason: 'passwordNoEncryption' };
        }
      } else if (cur?.account === acc) {
        passwordEnc = cur.passwordEnc || '';
      }
      kv.set(KEYS.credentials, { account: acc, passwordEnc });
      kv.remove(KEYS.autoLoginState);
      await kv.setSettings({ autoLogin: !!enabled });
      return { saved: true };
    },

    async forgetLogin() {
      kv.remove(KEYS.credentials, KEYS.autoLoginState, KEYS.siteSession);
      await kv.setSettings({ autoLogin: false });
    },

    /**
     * Log in with the saved credentials. Returns the new token, or null if automatic
     * login is off, not set up, rate-limited, or failed. `force` skips the rate limit
     * (the user just saved or asked for it).
     */
    async tryAutoLogin(client, { force = false, now = Date.now() } = {}) {
      const s = await kv.getSettings();
      if (!s.autoLogin) return null;
      const c = creds();
      if (!c?.passwordEnc) return null;
      const st = state();
      if (!force && st?.lastTryAt && now - st.lastTryAt < RETRY_AFTER_MS) return null;
      let pw;
      try {
        pw = await password();
      } catch (e) {
        kv.set(KEYS.autoLoginState, { ok: false, at: now, lastTryAt: now, error: `DPAPI: ${e?.message || e}`, rejected: null });
        await kv.appendAudit({ action: 'login', result: 'error', message: 'could not decrypt the saved password' });
        return null;
      }
      const fp = fingerprint(c.account, pw);
      // These exact credentials were refused: retrying could get the account locked.
      if (st?.rejected === fp) return null;

      try {
        const data = await client.login(c.account, pw);
        if (!usable(data?.token)) throw new Error('NO_TOKEN_IN_RESPONSE');
        tokens.store(data.token);
        kv.set(KEYS.siteSession, siteSessionFrom(data));
        kv.set(KEYS.autoLoginState, { ok: true, at: now, lastTryAt: now });
        if (s.sessionInvalid) await kv.setSettings({ sessionInvalid: false });
        await kv.appendAudit({ action: 'login', result: 'ok' });
        return data.token;
      } catch (e) {
        // A business error or a 4xx means the platform refused these credentials; a
        // network error, timeout or 5xx is worth another try later.
        const refused = typeof e?.status === 'number' && e.status !== 0 && !e.retryable;
        kv.set(KEYS.autoLoginState, { ok: false, at: now, lastTryAt: now, error: e?.message || String(e), rejected: refused ? fp : null });
        await kv.appendAudit({ action: 'login', result: 'error', message: e?.message || String(e) });
        return null;
      }
    },
  };
  return api;
}
