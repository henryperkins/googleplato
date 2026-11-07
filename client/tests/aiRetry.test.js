// A busy AI service (or this account's own limit) says how long to wait
// (server lib/ai-errors.js). The client waits that long, with jitter, and
// tells the learner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, parseResponse, retryDelay, MAX_RETRY_WAIT_MS } from '../js/api.js';
import { aiErrorMessage } from '../src/lib/aiErrors.js';

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('a 429 or 503 keeps the server’s retry hint', async () => {
  await assert.rejects(parseResponse(json({ code: 'ai_rate_limited', error: 'busy', retryAfterMs: 4000 }, 429)), { type: 'rate_limit', retryAfterMs: 4000 });
  await assert.rejects(parseResponse(json({ code: 'ai_overloaded', error: 'busy', retryAfterMs: 5000 }, 503)), { type: 'overloaded', retryAfterMs: 5000 });
});

test('waits as long as asked, plus up to a quarter more, else backs off from 3 s', () => {
  assert.equal(retryDelay({ retryAfterMs: 4000 }, 0, () => 0), 4000);
  assert.equal(retryDelay({ retryAfterMs: 4000 }, 0, () => 1), 5000);
  assert.equal(retryDelay({}, 0, () => 0), 3000);
  assert.equal(retryDelay({}, 1, () => 0), 6000);
  assert.ok(retryDelay({ retryAfterMs: 120_000 }, 0, () => 0) <= MAX_RETRY_WAIT_MS);
});

test('the learner is told how long to wait when the server said', () => {
  const busy = new ApiError('api', 'busy', 429, 'ai_rate_limited', 8000);
  assert.match(aiErrorMessage(busy, 'coach-reply'), /busy\. Wait about 8 seconds, then/);
  assert.match(aiErrorMessage(new ApiError('api', 'busy', 429, 'ai_rate_limited'), 'coach-reply'), /busy\. Wait a moment, then/);
});
