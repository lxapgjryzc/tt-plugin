// Node picker filters (requirements R7). Pure: no DOM, no chrome.*.

import { nodeStatus } from './model.js';
import { canQueue } from './scheduler.js';

// In display order; each node falls into exactly one, checked top to bottom (R7.1).
export const NODE_STATES = ['canQueue', 'queued', 'inReview', 'returned', 'approved', 'unavailable'];
export const DEFAULT_STATES = ['canQueue', 'queued', 'inReview', 'returned'];

/**
 * The picker state of one node (null for node-less work), plus the canQueue verdict the
 * picker shows next to it.
 */
export function nodeState(target, term, backlog, assignment, node) {
  const verdict = canQueue(target, term, backlog, assignment, node);
  const status = nodeStatus(assignment, node);
  let state;
  if (status === target.doneStatus) state = 'approved';
  else if (target.pendingStatuses.includes(status)) state = 'inReview';
  else if (target.needsRevisionStatuses.includes(status)) state = 'returned';
  else if (verdict.ok && verdict.followUp) state = 'queued';
  else if (verdict.ok) state = 'canQueue';
  else state = 'unavailable';
  return { state, verdict, status };
}

// Filter as stored: states shown, and assignment types hidden (so a type that appears
// later is shown by default).
export function defaultFilter() {
  return { states: [...DEFAULT_STATES], hiddenTypes: [] };
}

// Accept only what this version understands; anything else falls back to the defaults.
export function normalizeFilter(raw) {
  const states = Array.isArray(raw?.states) ? raw.states.filter((s) => NODE_STATES.includes(s)) : null;
  const hiddenTypes = Array.isArray(raw?.hiddenTypes) ? raw.hiddenTypes.filter((s) => typeof s === 'string') : [];
  return states ? { states, hiddenTypes } : defaultFilter();
}

export const typeOf = (assignment) => assignment?.assignmentType || 'OTHER';
