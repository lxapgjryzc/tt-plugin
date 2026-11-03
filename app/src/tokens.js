// The site's bearer token as the app keeps it. It comes from automatic login or from the
// extension, which reads it from an open tenten.art page (requirements R9.10, R9.18).

import { KEYS } from './kv.js';
import { fresherToken, usable } from './session.js';

export function makeTokens(kv) {
  return {
    get: () => kv.get(KEYS.token) || null,
    store: (token) => kv.set(KEYS.token, token || null),
    // A token handed over from the site page. Keeps whichever lasts longer, so the page's
    // older token never replaces a newer one from automatic login. Returns true when the
    // stored token changed.
    offer(token) {
      const prev = kv.get(KEYS.token) || null;
      if (!usable(token) || token === prev) return false;
      if (fresherToken(prev, token) === prev) return false;
      kv.set(KEYS.token, token);
      return true;
    },
  };
}
