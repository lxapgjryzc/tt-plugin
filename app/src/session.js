// Pure helpers about the site's session token.
//
// The token is a JWT with a fixed 24-hour lifetime and the site has no refresh
// endpoint, so the only way to keep going is a fresh login. These helpers let the
// app see the expiry coming instead of discovering it from a 401.

export const EXPIRING_SOON_MS = 60 * 60_000;

// Expiry of a JWT in epoch ms, or null if it is not a JWT with an `exp` claim.
export function tokenExpiry(token) {
  const part = typeof token === 'string' ? token.split('.')[1] : null;
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const exp = JSON.parse(json)?.exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// Fields the site keeps in localStorage["tenten-auth"] (as its own login does).
export const SITE_SESSION_FIELDS = [
  'token', 'userId', 'displayName', 'role', 'roles', 'mobile', 'mobileBound', 'email', 'emailBound',
  'profileCompleted', 'passwordSet', 'avatarUrl', 'studentNo',
];

export function siteSessionFrom(data) {
  const out = {};
  for (const k of SITE_SESSION_FIELDS) out[k] = data?.[k] ?? null;
  out.roles = Array.isArray(data?.roles) ? data.roles : [];
  out.avatarUrl = data?.avatarUrl || '';
  return out;
}

// 'ok' | 'expiring' | 'expired' | 'missing' | 'invalid'
export function sessionState({ token, sessionInvalid }, now = Date.now()) {
  if (sessionInvalid) return 'invalid';
  if (!token) return 'missing';
  const exp = tokenExpiry(token);
  if (exp === null) return 'ok';
  if (exp <= now) return 'expired';
  return exp - now <= EXPIRING_SOON_MS ? 'expiring' : 'ok';
}

// Of two tokens, the one to use: an unexpired one, and of two unexpired ones the one
// that lasts longer (ties go to `a`). Tokens without an expiry count as unexpired but
// never beat one that has a known expiry in the future. Null if neither is usable.
export function fresherToken(a, b, now = Date.now()) {
  const left = (t) => {
    if (!t) return null;
    const exp = tokenExpiry(t);
    if (exp === null) return 0;
    return exp > now ? exp : null;
  };
  const la = left(a);
  const lb = left(b);
  if (lb !== null && (la === null || lb > la)) return b;
  return la !== null ? a : null;
}

// A token we can still use: not past its JWT expiry (tokens without one are trusted).
export function usable(token, now = Date.now()) {
  if (!token) return false;
  const exp = tokenExpiry(token);
  return exp === null || exp > now;
}
