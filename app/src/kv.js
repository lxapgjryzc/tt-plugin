// Small state next to the queue: settings, session, snapshot, activity log, and the
// in-process check lock. Values are JSON in the `kv` table.

import { DEFAULT_REVIEW_HOURS } from './review-hours.js';
import { transaction } from './db.js';

export const KEYS = {
  settings: 'settings',
  snapshot: 'snapshot', // last term summary (the queue page header, the extension's badge)
  token: 'token', // the site's bearer token
  lastTick: 'lastTick',
  sessionNotice: 'sessionNotice', // which login notification was last shown
  credentials: 'credentials', // { account, passwordEnc } for automatic login (opt-in)
  autoLoginState: 'autoLoginState', // result of the last automatic login
  siteSession: 'siteSession', // session object from the last automatic login, for the site
  lastPick: 'lastPick', // last node queued, for the site badge
  appKey: 'appKey', // the local API's secret (R9.12)
};

export const DEFAULTS = {
  activeTermId: null,
  paused: false,
  autoSubmit: false,
  dryRun: true,
  tickSeconds: 60,
  sessionInvalid: false,
  locale: 'auto', // 'auto' follows the browser (pages) or Windows (notifications); or 'en' / 'zh_CN'
  autoLogin: false, // log in with the saved password when the session runs out
  reviewHoursOn: true, // skip the periodic check while TAs are off duty
  reviewHours: DEFAULT_REVIEW_HOURS, // Beijing time
};

export const MIN_TICK = 30;
export const AUDIT_MAX = 200;
export const LOCK_TTL_MS = 3 * 60_000;

// Settings fields the queue page may change.
const SETTABLE = new Set(['activeTermId', 'paused', 'autoSubmit', 'dryRun', 'tickSeconds', 'locale', 'reviewHoursOn', 'reviewHours']);
export const pageSettingsPatch = (patch) => Object.fromEntries(Object.entries(patch || {}).filter(([k]) => SETTABLE.has(k)));

export function makeKv(db, { now = () => Date.now() } = {}) {
  const q = {
    get: db.prepare('SELECT value FROM kv WHERE key = ?'),
    set: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    del: db.prepare('DELETE FROM kv WHERE key = ?'),
    auditAdd: db.prepare('INSERT INTO audit (data) VALUES (?)'),
    auditTrim: db.prepare('DELETE FROM audit WHERE seq <= (SELECT MAX(seq) FROM audit) - ?'),
    auditAll: db.prepare('SELECT data FROM audit ORDER BY seq'),
  };

  const get = (key) => {
    const r = q.get.get(key);
    return r ? JSON.parse(r.value) : undefined;
  };
  const set = (key, value) => {
    if (value === undefined || value === null) q.del.run(key);
    else q.set.run(key, JSON.stringify(value));
  };

  let lock = null; // { owner, at }: one check (or withdrawal) at a time (R9.3)

  return {
    get,
    set,
    remove: (...keys) => { for (const k of keys.flat()) q.del.run(k); },

    async getSettings() { return { ...DEFAULTS, ...(get(KEYS.settings) || {}) }; },
    async setSettings(patch) {
      return transaction(db, () => {
        const next = { ...DEFAULTS, ...(get(KEYS.settings) || {}), ...patch };
        next.tickSeconds = Math.max(MIN_TICK, Math.round(Number(next.tickSeconds) || DEFAULTS.tickSeconds));
        set(KEYS.settings, next);
        return next;
      });
    },

    async appendAudit(entry) {
      transaction(db, () => {
        q.auditAdd.run(JSON.stringify({ at: new Date(now()).toISOString(), ...entry }));
        q.auditTrim.run(AUDIT_MAX);
      });
    },
    async getAudit() { return q.auditAll.all().map((r) => JSON.parse(r.data)); },

    lock: {
      async acquire(owner) {
        if (lock && now() - lock.at < LOCK_TTL_MS) return false;
        lock = { owner, at: now() };
        return true;
      },
      async refresh(owner) {
        if (lock?.owner !== owner) return false;
        lock.at = now();
        return true;
      },
      async release(owner) { if (lock?.owner === owner) lock = null; },
    },
  };
}
