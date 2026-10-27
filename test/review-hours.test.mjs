import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewHours, inReviewHours, beijingMinutes, nextWindowStart, DEFAULT_REVIEW_HOURS,
} from '../extension/src/review-hours.js';

// A Beijing wall-clock time on 2026-10-28 as epoch ms.
const bj = (hhmm) => Date.parse(`2026-10-28T${hhmm}:00+08:00`);

test('parse', () => {
  assert.deepEqual(parseReviewHours(DEFAULT_REVIEW_HOURS), [[600, 900], [1080, 1380]]);
  assert.deepEqual(parseReviewHours('9:30-12:00，22:00-02:00'), [[570, 720], [1320, 120]]);
  assert.deepEqual(parseReviewHours('00:00-24:00'), [[0, 1440]]);
  assert.equal(parseReviewHours(''), null);
  assert.equal(parseReviewHours('10-15'), null);
  assert.equal(parseReviewHours('10:00-10:00'), null);
  assert.equal(parseReviewHours('25:00-26:00'), null);
});

test('beijingMinutes does not depend on the local timezone', () => {
  assert.equal(beijingMinutes(bj('00:00')), 0);
  assert.equal(beijingMinutes(bj('19:35')), 19 * 60 + 35);
});

test('default windows with the 30 minute grace', () => {
  const w = parseReviewHours(DEFAULT_REVIEW_HOURS);
  const on = (t) => inReviewHours(w, bj(t));
  assert.equal(on('09:59'), false);
  assert.equal(on('10:00'), true);
  assert.equal(on('15:20'), true, 'grace after the midday window');
  assert.equal(on('15:31'), false);
  assert.equal(on('17:59'), false);
  assert.equal(on('18:00'), true);
  assert.equal(on('23:29'), true, 'grace after the evening window');
  assert.equal(on('23:30'), false);
  assert.equal(on('03:00'), false);
});

test('window across midnight, and no windows means always on', () => {
  const w = parseReviewHours('22:00-02:00');
  assert.equal(inReviewHours(w, bj('23:00')), true);
  assert.equal(inReviewHours(w, bj('01:59')), true);
  assert.equal(inReviewHours(w, bj('02:29')), true);
  assert.equal(inReviewHours(w, bj('03:00')), false);
  assert.equal(inReviewHours(null, bj('03:00')), true);
  assert.equal(inReviewHours(parseReviewHours('00:00-24:00'), bj('03:00')), true);
  assert.equal(inReviewHours(parseReviewHours('00:00-23:50'), bj('23:55')), true);
});

test('nextWindowStart', () => {
  const w = parseReviewHours(DEFAULT_REVIEW_HOURS);
  assert.equal(nextWindowStart(w, bj('03:00')), bj('10:00'));
  assert.equal(nextWindowStart(w, bj('16:10')), bj('18:00'));
  assert.equal(nextWindowStart(w, bj('23:40')), Date.parse('2026-10-29T10:00:00+08:00'));
});
