import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeInferenceLogs, estimateInferenceCost } from '../../src/lib/inference-report.js';

const rates = { version: 'fixture-v1', rates: [{ provider: 'workers-ai', model: 'model', region: 'global',
  input_usd_per_million: 1, cached_input_usd_per_million: 0.1, output_usd_per_million: 2 }] };
const usage = { prompt_tokens: 1000, output_tokens: 500, reasoning_tokens: 400, visible_output_tokens: 100,
  cached_input_tokens: 0, cache_write_tokens: 0, usage_complete: true, provider_retries: 0, client_retry_index: 0,
  latency_ms: 2000, time_to_first_visible_token_ms: 500, outcome: 'success' };
const common = { schema_version: 1, provider: 'workers-ai', model: 'model', region: 'global', agent_role: 'coach' };
const event = (code, meta, ts = '2026-10-20T01:00:00Z') => ({ code, meta: { ...common, ...meta }, ts });
function invocation(id, attempt, overrides = {}, ts) {
  return [event('inference_started', { inference_id: id, attempt_ref: attempt, turn_ref: id }, ts),
    event('inference_finished', { inference_id: id, attempt_ref: attempt, turn_ref: id, ...usage, ...overrides }, ts)];
}
const scan = entries => ({ entries, complete: true, since: '2026-10-19T00:00:00Z', until: '2026-10-21T12:00:00Z' });

test('includes abandoned and enrichment spend in cost per completed lesson without double-counting retries or delivery', () => {
  const entries = [
    ...invocation('coach-1', 'completed'),
    ...invocation('observation', 'completed', { agent_role: 'learner-profile-update' }),
    event('lesson_attempt_saved', { attempt_ref: 'completed', turn_ref: 'coach-1', lesson_attempt_status: 'completed' }),
    ...invocation('abandoned-1', 'abandoned'),
    ...invocation('abandoned-retry', 'abandoned', { client_retry_index: 1 }),
    ...invocation('active-1', 'active', {}, '2026-10-21T11:50:00Z'),
    ...invocation('admin-1', undefined, { agent_role: 'admin-test' }),
  ];
  entries.push(structuredClone(entries[1]), structuredClone(entries[4]));
  const report = summarizeInferenceLogs(scan(entries), { rateCard: rates });
  assert.equal(report.total.invocations, 6);
  assert.equal(report.lessons.invocations, 5);
  assert.equal(report.lessons.estimated_cost_usd, 0.01);
  assert.equal(report.unattributed.estimated_cost_usd, 0.002);
  assert.equal(report.cost_per_completed_lesson_usd, 0.01);
  assert.equal(report.completed_attempts, 1);
  assert.deepEqual(report.attempts.map(x => x.status).sort(), ['abandoned', 'active', 'completed']);
  assert.equal(report.by_status.abandoned.estimated_cost_usd, 0.004);
  assert.equal(report.lessons.client_retry_invocations, 1);
  assert.equal(report.lessons.observation_invocations, 1);
  assert.equal(report.lessons.tokens.reasoning_tokens.reported, 2000);
  assert.equal(report.lessons.tokens.output_tokens.reported, 2500, 'reasoning is not billed twice');
});

test('completion confirmed by persistence-only recovery reclassifies the original spend', () => {
  const entries = invocation('retained-coach', 'attempt');
  const before = summarizeInferenceLogs(scan(entries), { rateCard: rates });
  assert.equal(before.attempts[0].status, 'abandoned');
  entries.push(event('lesson_attempt_saved', { attempt_ref: 'attempt', turn_ref: 'retained-coach', lesson_attempt_status: 'completed' }, '2026-10-21T11:00:00Z'));
  const after = summarizeInferenceLogs(scan(entries), { rateCard: rates });
  assert.equal(after.attempts[0].status, 'completed');
  assert.equal(after.total.invocations, 1);
  assert.equal(after.cost_per_completed_lesson_usd, 0.002);
});

test('missing terminal events, unreported tokens and unmetered SDK retries make cost incomplete', () => {
  const entries = [event('inference_started', { inference_id: 'killed', attempt_ref: 'attempt' }),
    ...invocation('unknown-usage', 'attempt', { prompt_tokens: null, output_tokens: null, reasoning_tokens: null, usage_complete: false, outcome: 'error' }),
    ...invocation('sdk-retry', 'attempt', { provider_retries: 2, usage_complete: false })];
  const report = summarizeInferenceLogs(scan(entries), { rateCard: rates });
  assert.equal(report.total.invocations, 3);
  assert.equal(report.total.missing_finish_events, 1);
  assert.equal(report.total.unpriced_invocations, 2);
  assert.equal(report.total.provider_retries, 2);
  assert.equal(report.total.cost_complete, false);
  assert.equal(report.total.estimated_cost_usd, 0.002);
  assert.equal(report.total.tokens.prompt_tokens.missing, 2);
  assert.equal(report.cost_per_completed_lesson_usd, null, 'no completed lesson denominator');
});

test('cache discounts, missing rates and region-specific Bedrock prices are explicit', () => {
  const cf = estimateInferenceCost({ ...common, ...usage, cached_input_tokens: 500 }, rates);
  assert.equal(cf.estimated_cost_usd, 0.00155);
  assert.equal(estimateInferenceCost({ ...common, ...usage, cached_input_tokens: null }, rates).cache_assumed_uncached, true);
  assert.equal(estimateInferenceCost({ ...common, ...usage, model: 'unpriced' }, rates).estimated_cost_usd, null);
  assert.equal(estimateInferenceCost({ ...common, ...usage, cached_input_tokens: 2000 }, rates).estimated_cost_usd, null);
  const bedrockRates = { version: 'regional', rates: [{ provider: 'bedrock', model: 'model', region: 'us-east-2', input_usd_per_million: 1, output_usd_per_million: 2 }] };
  assert.equal(estimateInferenceCost({ ...common, ...usage, provider: 'bedrock', region: 'us-east-1' }, bedrockRates).estimated_cost_usd, null);
  bedrockRates.rates[0].cache_write_usd_per_million = 1.5;
  const missingWrites = { ...common, ...usage, provider: 'bedrock', region: 'us-east-2', cache_write_tokens: null };
  assert.equal(estimateInferenceCost(missingWrites, bedrockRates).cache_assumed_zero_write, true);
  const report = summarizeInferenceLogs(scan(invocation('cache', 'attempt', missingWrites)), { rateCard: bedrockRates });
  assert.equal(report.total.cost_complete, false);
});

test('an incomplete scan or malformed measurement never produces a confident cost report', () => {
  assert.throws(() => summarizeInferenceLogs({ ...scan([]), complete: false }), /incomplete/i);
  assert.throws(() => summarizeInferenceLogs(scan([event('inference_finished', {})])), /invalid/i);
  assert.throws(() => summarizeInferenceLogs(scan([]), { abandonAfterMs: -1 }), /abandon/i);
  assert.throws(() => summarizeInferenceLogs(scan([]), { rateCard: { version: 'bad', rates: [{ ...rates.rates[0], output_usd_per_million: -1 }] } }), /rate/i);
});

test('missing lesson context from an older tab cannot make lesson cost coverage appear complete', () => {
  const entries = [...invocation('new', 'attempt'), ...invocation('old-tab', undefined, { agent_role: 'unknown' }),
    event('lesson_attempt_saved', { attempt_ref: 'attempt', lesson_attempt_status: 'completed' })];
  const report = summarizeInferenceLogs(scan(entries), { rateCard: rates });
  assert.equal(report.total.cost_complete, true);
  assert.equal(report.lesson_attribution_complete, false);
  assert.equal(report.missing_lesson_context_invocations, 1);
  assert.equal(report.cost_per_completed_lesson_complete, false);
});
