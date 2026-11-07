import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IN_FLIGHT, RATE_PER_MINUTE, acquire, userLimitError, _resetAiLimits } from '../../src/lib/ai-limits.js';
import { classifyAiError } from '../../src/lib/ai-errors.js';

describe('per-user AI limits', () => {
  beforeEach(() => _resetAiLimits());

  it('allows 30 calls a minute, then says how long to wait', () => {
    for (let i = 0; i < RATE_PER_MINUTE; i++) acquire('actor-a', 0).release();
    const refused = acquire('actor-a', 0);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'rate');
    assert.equal(refused.retryAfterMs, 2000, 'one call refills every 2 s');
    assert.equal(acquire('actor-a', 2000).ok, true);
    assert.equal(acquire('actor-b', 0).ok, true, 'other users are untouched');
  });

  it('allows 4 calls in flight at once', () => {
    const held = Array.from({ length: MAX_IN_FLIGHT }, () => acquire('actor-a', 0));
    assert.ok(held.every((s) => s.ok));
    assert.deepEqual(acquire('actor-a', 0), { ok: false, reason: 'in_flight', retryAfterMs: 2000 });
    held[0].release();
    held[0].release(); // releasing twice frees one slot, not two
    assert.equal(acquire('actor-a', 0).ok, true);
    assert.equal(acquire('actor-a', 0).ok, false);
  });

  it('never limits a call without a user', () => {
    for (let i = 0; i < 100; i++) assert.equal(acquire(undefined).ok, true);
  });
});

describe('typed AI errors', () => {
  it('types this account’s own limit as ai_rate_limited with its wait', () => {
    const typed = classifyAiError(userLimitError({ reason: 'rate', retryAfterMs: 1800 }));
    assert.equal(typed.code, 'ai_rate_limited');
    assert.equal(typed.retryAfterMs, 1800);
  });

  it('tells clients to wait 5 s for a busy provider, and gives no wait for other failures', () => {
    assert.equal(classifyAiError(Object.assign(new Error('x'), { name: 'ThrottlingException' })).retryAfterMs, 5000);
    assert.equal(classifyAiError(Object.assign(new Error('x'), { status: 429 })).retryAfterMs, 5000);
    assert.equal(classifyAiError(Object.assign(new Error('x'), { name: 'ServiceUnavailableException' })).retryAfterMs, 5000);
    assert.equal(classifyAiError(Object.assign(new Error('x'), { name: 'ValidationException' })).retryAfterMs, undefined);
  });
});
