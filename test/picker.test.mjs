// Requirements R7: node picker filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTerm, ids, item, target, addRound } from './fixtures.mjs';
import { findAssignment } from '../app/src/model.js';
import { nodeState, normalizeFilter, defaultFilter, DEFAULT_STATES, NODE_STATES } from '../app/src/picker.js';

const stateOf = (term, backlog, aid, nodeIndex) => {
  const a = findAssignment(term, aid);
  return nodeState(target, term, backlog, a, a.nodes[nodeIndex]).state;
};

test('every node falls into exactly one state', () => {
  const term = makeTerm();
  assert.equal(stateOf(term, [], ids.A1, 0), 'approved');
  assert.equal(stateOf(term, [], ids.A1, 1), 'canQueue');
  assert.equal(stateOf(term, [], ids.A1, 2), 'unavailable', 'locked, nothing before it queued');
  assert.equal(stateOf(term, [item()], ids.A1, 1), 'queued', 'our item waits, not submitted yet');
  assert.equal(stateOf(term, [item()], ids.A1, 2), 'canQueue', 'locked but chained behind a queued node');
  assert.equal(stateOf(term, [], ids.A3, 0), 'unavailable', 'closed assignment');
  addRound(term, ids.A1, ids.A1n2, 'REVIEWING');
  assert.equal(stateOf(term, [item()], ids.A1, 1), 'inReview', 'review status wins over our queued item');
  addRound(term, ids.A1, ids.A1n2, 'RETURNED');
  assert.equal(stateOf(term, [], ids.A1, 1), 'returned');
});

test('default filter matches the old default view; stored filters are sanitised', () => {
  assert.deepEqual(DEFAULT_STATES.filter((s) => !NODE_STATES.includes(s)), []);
  assert.ok(!DEFAULT_STATES.includes('approved') && !DEFAULT_STATES.includes('unavailable'));
  assert.deepEqual(normalizeFilter(null), defaultFilter());
  assert.deepEqual(normalizeFilter('garbage'), defaultFilter());
  assert.deepEqual(normalizeFilter({ states: ['approved', 'bogus'], hiddenTypes: ['DRILL', 3] }), { states: ['approved'], hiddenTypes: ['DRILL'] });
  assert.deepEqual(normalizeFilter({ states: [] }), { states: [], hiddenTypes: [] }, 'an empty selection is kept');
});
