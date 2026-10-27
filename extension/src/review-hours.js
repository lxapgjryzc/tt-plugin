// Review hours: when the platform's TAs actually review, in Beijing time.
//
// Measured from one student's 41 reviews and 83 review notifications (Oct 2026):
// all of them fell in 10:00-15:00 and 18:00-23:00 Beijing time, every day of the
// week. Outside these windows no slot can free up, so the periodic check is skipped.
// Pure functions; no chrome.*.

export const DEFAULT_REVIEW_HOURS = '10:00-15:00, 18:00-23:00';
// Keep checking a little after a window ends, so a slot freed by the last review of
// the evening is still filled right away (the review queue is ordered by submit time).
export const GRACE_MIN = 30;
const BEIJING_OFFSET_MIN = 8 * 60;
const DAY = 24 * 60;

// "10:00-15:00, 18:00-23:00" -> [[600, 900], [1080, 1380]]; null if anything is malformed.
// A window may wrap past midnight ("22:00-02:00").
export function parseReviewHours(text) {
  const parts = String(text ?? '').split(/[,，;；\s]+/).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    const m = /^(\d{1,2}):(\d{2})[-–~](\d{1,2}):(\d{2})$/.exec(p);
    if (!m) return null;
    const [h1, m1, h2, m2] = m.slice(1).map(Number);
    if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return null;
    const start = h1 * 60 + m1;
    const end = h2 * 60 + m2;
    if (start === end) return null;
    out.push([start % DAY, end === DAY ? DAY : end % DAY]);
  }
  return out;
}

// Minutes since midnight, Beijing time.
export function beijingMinutes(now = Date.now()) {
  const utc = Math.floor(now / 60_000) % DAY;
  return (utc + BEIJING_OFFSET_MIN) % DAY;
}

// Should the periodic check run now? Windows are extended by `grace` minutes at the end.
export function inReviewHours(windows, now = Date.now(), grace = GRACE_MIN) {
  if (!windows || !windows.length) return true;
  const min = beijingMinutes(now);
  return windows.some(([start, end]) => {
    const length = (end - start + DAY) % DAY || DAY;
    if (length + grace >= DAY) return true;
    return (min - start + DAY) % DAY < length + grace;
  });
}

// Next time (epoch ms) a window opens, for "checks resume at …".
export function nextWindowStart(windows, now = Date.now()) {
  if (!windows || !windows.length) return null;
  const min = beijingMinutes(now);
  const startOfMinute = Math.floor(now / 60_000) * 60_000;
  const waits = windows.map(([start]) => (start - min + DAY) % DAY || DAY);
  return startOfMinute + Math.min(...waits) * 60_000;
}
