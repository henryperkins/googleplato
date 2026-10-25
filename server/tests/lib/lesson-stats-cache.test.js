import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshStaleLessonStats, kickoffAsyncRefresh, _resetStaleRefreshForTests,
} from '../../src/lib/lesson-stats-cache.js';

describe('lesson-stats-cache stale refresh (PR-8)', () => {
  const savedFn = process.env.AWS_LAMBDA_FUNCTION_NAME;
  beforeEach(() => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    _resetStaleRefreshForTests();
  });
  afterEach(() => {
    _resetStaleRefreshForTests();
    if (savedFn === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = savedFn;
  });

  it('returns the fresh result when the recompute finishes within the budget', async () => {
    const fresh = await refreshStaleLessonStats(async () => ({ computedAt: 't1', stats: { totalCompletions: 3 } }), 1000);
    assert.deepEqual(fresh, { computedAt: 't1', stats: { totalCompletions: 3 } });
  });

  it('returns null when the recompute outlives the budget, then joins the same flight', async () => {
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const recompute = async () => {
      calls++;
      await gate;
      return { computedAt: 't2', stats: { totalCompletions: 9 } };
    };
    const first = await refreshStaleLessonStats(recompute, 25);
    assert.equal(first, null, 'slow recompute yields the stale cache');
    const joined = refreshStaleLessonStats(recompute, 1000);
    release();
    assert.deepEqual(await joined, { computedAt: 't2', stats: { totalCompletions: 9 } });
    assert.equal(calls, 1, 'concurrent stale reads share one recompute');
  });

  it('returns null when the recompute fails, so callers serve stale', async () => {
    const result = await refreshStaleLessonStats(async () => { throw new Error('db down'); }, 1000);
    assert.equal(result, null);
  });

  it('kickoffAsyncRefresh is a no-op off Lambda', async () => {
    assert.equal(await kickoffAsyncRefresh(), undefined);
  });
});
