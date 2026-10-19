/**
 * Tests for mergeCompletedLessonIds — the monotonic union that builds a
 * course's completed-lesson id list after each completion. Regression guard for
 * the bug where `result.completedLessonIds || prior` dropped prior ids when the
 * agent returned an empty array (`[] || x` is truthy), and for double-counting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// courseProgressQueue imports storage/orchestrator, which touch these globals
// at import time (mirrors lesson-context.test.js).
globalThis.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = v; },
  removeItem(k) { delete this._store[k]; },
  clear() { this._store = {}; },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });

const { mergeCompletedLessonIds } = await import('../src/lib/courseProgressQueue.js');

describe('mergeCompletedLessonIds', () => {
  it('adds the just-completed lesson to an empty prior list', () => {
    assert.deepEqual(mergeCompletedLessonIds([], ['A'], 'A'), ['A']);
  });

  it('does not double-count when the agent already includes the current lesson', () => {
    // Out-of-order story: complete A, then B; the agent returns the full set.
    assert.deepEqual(mergeCompletedLessonIds(['A'], ['A', 'B'], 'B'), ['A', 'B']);
  });

  it('keeps prior ids when the agent returns an empty array (the bug)', () => {
    // The bug: `result.completedLessonIds || prior` evaluated to `[]` because the
    // empty array is itself truthy, so `||` short-circuits to it and prior was
    // dropped → old result [B]. The union keeps A.
    assert.deepEqual(mergeCompletedLessonIds(['A'], [], 'B'), ['A', 'B']);
  });

  it('keeps prior ids when the agent omits the field entirely', () => {
    assert.deepEqual(mergeCompletedLessonIds(['A'], undefined, 'B'), ['A', 'B']);
  });

  it('unions a prior id the agent forgot to return (never loses completions)', () => {
    assert.deepEqual(mergeCompletedLessonIds(['A'], ['B'], 'B'), ['A', 'B']);
  });

  it('tolerates a missing lessonId without inserting undefined', () => {
    assert.deepEqual(mergeCompletedLessonIds(['A'], ['A'], undefined), ['A']);
  });

  it('tolerates malformed (non-array) prior / returned values', () => {
    assert.deepEqual(mergeCompletedLessonIds(null, null, 'A'), ['A']);
  });
});
