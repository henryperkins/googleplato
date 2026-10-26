import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInferenceTelemetry, inferenceContext, normalizeUsage } from '../../src/lib/inference-telemetry.js';

test('metadata repair retains its operation role and the original lesson attempt identity', () => {
  const context = inferenceContext('synthetic', { agentRole: 'coach-assessment-repair', lessonId: 'lesson', generation: null, turnId: 'turn' });
  assert.equal(context.agent_role, 'coach-assessment-repair');
  const original = inferenceContext('synthetic', { agentRole: 'coach', lessonId: 'lesson', generation: null, turnId: 'turn' });
  assert.equal(context.attempt_ref, original.attempt_ref);
  assert.equal(context.turn_ref, original.turn_ref);
});

test('keeps reasoning inside total output and missing counts unknown', () => {
  assert.deepEqual(normalizeUsage('workers-ai', {
    prompt_tokens: 100, completion_tokens: 60,
    completion_tokens_details: { reasoning_tokens: 40 }, prompt_tokens_details: { cached_tokens: 25 },
  }), { prompt_tokens: 100, output_tokens: 60, reasoning_tokens: 40, visible_output_tokens: 20,
    cached_input_tokens: 25, cache_write_tokens: 0 });
  const missing = normalizeUsage('workers-ai', {});
  assert.equal(missing.prompt_tokens, null);
  assert.equal(missing.output_tokens, null);
  assert.equal(missing.reasoning_tokens, null);
  const bedrock = normalizeUsage('converse', { inputTokens: 100, outputTokens: 60 });
  assert.equal(bedrock.reasoning_tokens, null, 'Converse does not report a reasoning breakdown');
  assert.equal(bedrock.visible_output_tokens, null);
  assert.equal(normalizeUsage('workers-ai', { prompt_tokens: -1, completion_tokens: '10' }).output_tokens, null);
  assert.equal(normalizeUsage('workers-ai', { completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 9 } }).reasoning_tokens, null);
});

test('correlates reloads but separates owners and resets without logging their content', () => {
  const raw = { lessonId: 'private-lesson', generation: null, turnId: 'turn-1', agentRole: 'coach', operationId: 'op-1', retryIndex: 1, prompt: 'secret' };
  const first = inferenceContext('private-user', raw);
  assert.equal(first.attempt_ref, inferenceContext('private-user', { ...raw, turnId: 'turn-2' }).attempt_ref);
  assert.notEqual(first.attempt_ref, inferenceContext('other-user', raw).attempt_ref);
  assert.notEqual(first.attempt_ref, inferenceContext('private-user', { ...raw, generation: 'reset-2' }).attempt_ref);
  assert.doesNotMatch(JSON.stringify(first), /private-|secret/);
  assert.equal(inferenceContext('private-user', { lessonId: {}, generation: null, agentRole: 'secret-prompt' }).attempt_ref, undefined);
  assert.equal(inferenceContext('private-user', { agentRole: 'secret-prompt' }).agent_role, 'unknown');
});

test('measures the first visible text and total latency, retaining partial usage on cancellation', () => {
  let time = 100;
  const events = [];
  const t = createInferenceTelemetry({ provider: 'workers-ai', model: 'model', stream: true }, {
    now: () => time, emit: (code, meta) => events.push({ code, ...meta }),
  });
  time = 110; t.visible('  ');
  t.observe({ format: 'workers-ai', usage: { prompt_tokens: 10 }, attempts: 1 });
  time = 150; t.visible('Hello');
  time = 180; t.visible(' world');
  time = 200; t.finish('cancelled'); t.finish('success');
  assert.equal(events.length, 2);
  assert.equal(events[0].code, 'inference_started');
  assert.equal(events[1].code, 'inference_finished');
  assert.equal(events[1].inference_id, events[0].inference_id);
  assert.equal(events[1].time_to_first_visible_token_ms, 50);
  assert.equal(events[1].latency_ms, 100);
  assert.equal(events[1].outcome, 'cancelled');
  assert.equal(events[1].prompt_tokens, 10);
  assert.equal(events[1].output_tokens, null);
  assert.equal(events[1].usage_complete, false);
  assert.equal(events[1].provider_retries, 0);
});

test('merges cumulative Anthropic usage and reports SDK retries without summing snapshots', () => {
  const events = [];
  const t = createInferenceTelemetry({ provider: 'bedrock', model: 'model' }, { emit: (code, meta) => events.push({ code, ...meta }) });
  t.observe({ attempts: 3, retryDelayMs: 1500 });
  t.observe({ format: 'anthropic', usage: { input_tokens: 40, output_tokens: 1 } });
  t.observe({ format: 'anthropic', usage: { output_tokens: 20 } });
  t.finish('success');
  assert.equal(events[1].prompt_tokens, 40);
  assert.equal(events[1].output_tokens, 20);
  assert.equal(events[1].provider_retries, 2);
  assert.equal(events[1].provider_retry_delay_ms, 1500);
  assert.equal(events[1].usage_complete, false, 'SDK retry attempts do not report their billed usage');
});

test('a broken log sink cannot fail inference', () => {
  assert.doesNotThrow(() => {
    const t = createInferenceTelemetry({}, { emit: () => { throw new Error('sink down'); }, warn: () => { throw new Error('sink down'); } });
    t.observe(null); t.visible('hello'); t.fail('ai_error', new Error('boom')); t.finish('error', 'ai_error');
  });
});

test('reports a failure once as a content-free warning carrying the invocation identity', () => {
  const events = [];
  const warnings = [];
  const t = createInferenceTelemetry({ provider: 'workers-ai', model: 'model', stream: true, context: { agent_role: 'coach' } }, {
    emit: (code, meta) => events.push({ code, ...meta }), warn: (code, meta) => warnings.push({ code, ...meta }),
  });
  const error = Object.assign(new Error('secret provider text'), {
    name: 'WorkersAiError', status: 401, httpStatus: 401, reason: 'http', credentialSource: 'oauth', tokenExpiresInS: 75,
  });
  t.fail('ai_unavailable', error);
  t.finish('error', 'ai_unavailable');
  t.fail('ai_unavailable', error);
  assert.deepEqual(warnings, [{
    code: 'ai_provider_error', schema_version: 1, inference_id: events[0].inference_id, provider: 'workers-ai', model: 'model',
    stream: true, agent_role: 'coach', error_code: 'ai_unavailable', stage: 'provider', reason: 'http', error_name: 'WorkersAiError',
    http_status: 401, cause_code: null, credential_source: 'oauth', token_expires_in_s: 75,
  }]);
  assert.equal(events[1].error_code, 'ai_unavailable');
  assert.doesNotMatch(JSON.stringify(warnings), /secret/);
});

test('later cumulative output cannot retain an obsolete reasoning or visible-token breakdown', () => {
  const events = [];
  const t = createInferenceTelemetry({ provider: 'workers-ai' }, { emit: (code, meta) => events.push({ code, ...meta }) });
  t.observe({ format: 'workers-ai', usage: { prompt_tokens: 100, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 40 } } });
  t.observe({ format: 'workers-ai', usage: { completion_tokens: 100 }, finalUsage: true, attempts: 1 });
  t.finish('success');
  assert.equal(events[1].output_tokens, 100);
  assert.equal(events[1].reasoning_tokens, null);
  assert.equal(events[1].visible_output_tokens, null);
});
