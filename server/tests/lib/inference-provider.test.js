import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import ai from '../../src/lib/ai-provider.js';
import db from '../../src/lib/db.js';
import { logger } from '../../src/lib/logger.js';
import { Hono } from 'hono';
import sync from '../../src/routes/sync.js';
import { on } from '../../src/lib/plugins/hooks.js';
import { signAccessToken } from '../../src/lib/jwt.js';
import { inferenceContext } from '../../src/lib/inference-telemetry.js';
import { currentClientHeaders } from '../helpers/clientCompatibility.js';

const model = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const settings = { provider: 'workers-ai', workersAiModel: model };
const body = { max_tokens: 512, messages: [{ role: 'user', content: 'secret learner content' }] };
let active;
const originalEnv = { ...process.env };
beforeEach(() => {
  active = settings;
  mock.method(db, 'getSyncData', async (_user, key) => key === 'ai-settings' ? { data: active } : null);
  process.env.CLOUDFLARE_ACCOUNT_ID = 'b'.repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = 'secret-provider-token';
  logger._reset();
  mock.method(console, 'log', () => {});
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});
const finished = () => logger.recent().find(e => e.code === 'inference_finished')?.meta;

test('real Workers adapter records reported usage without changing the reasoning or token budget', async () => {
  mock.method(globalThis, 'fetch', async (_url, options) => {
    const sent = JSON.parse(options.body);
    assert.equal(sent.reasoning_effort, 'max');
    assert.equal(sent.max_tokens, 8704);
    assert.equal(sent.messages[0].content, 'secret learner content');
    return Response.json({ choices: [{ message: { content: 'secret reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 40 } } });
  });
  const response = await ai.invoke('ignored', body);
  assert.equal(response.content[0].text, 'secret reply');
  assert.equal(finished()?.reasoning_tokens, 40);
  assert.equal(finished().output_tokens, 60);
  assert.equal(finished().visible_output_tokens, 20);
  assert.equal(finished().usage_complete, true);
  assert.equal(finished().provider_retries, 0);
  assert.equal(finished().model, model);
  assert.ok(finished().time_to_first_visible_token_ms >= 0);
  assert.doesNotMatch(JSON.stringify(logger.recent()), /secret/);
});

test('Workers stream counts trailing usage, excluding reasoning and empty deltas from visible output', async () => {
  mock.method(globalThis, 'fetch', async () => new Response([
    { choices: [{ delta: { reasoning_content: 'secret thinking' } }] },
    { choices: [{ delta: { content: 'Visible' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 24 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } }));
  const events = [];
  for await (const event of ai.invokeStream('ignored', body)) events.push(event);
  assert.equal(finished()?.reasoning_tokens, 24);
  assert.equal(finished().visible_output_tokens, 6);
  assert.equal(finished().usage_complete, true);
  assert.doesNotMatch(JSON.stringify(events), /thinking/);
});

test('missing usage and provider errors remain unknown rather than free requests', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  await ai.invoke('ignored', body);
  assert.equal(finished()?.output_tokens, null);
  assert.equal(finished().usage_complete, false);
  mock.method(globalThis, 'fetch', async () => new Response('secret error', { status: 503 }));
  await assert.rejects(ai.invoke('ignored', body));
  assert.equal(finished().outcome, 'error');
  assert.equal(finished().provider_attempts, 1);
  assert.doesNotMatch(JSON.stringify(logger.recent()), /secret/);
});

test('usage in an interrupted Workers stream is partial even when both token counts were reported', async () => {
  mock.method(globalThis, 'fetch', async () => new Response([
    { choices: [{ delta: { content: 'Partial' } }], usage: { prompt_tokens: 100, completion_tokens: 4 } },
    { error: { status: 503 } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(async () => { for await (const _event of ai.invokeStream('ignored', body)) { /* drain */ } });
  assert.equal(finished().output_tokens, 4);
  assert.equal(finished().outcome, 'error');
  assert.equal(finished().usage_complete, false);
});

test('Bedrock Converse usage and SDK retries survive the compatibility translation', async () => {
  active = { ...settings, provider: 'bedrock' };
  mock.method(BedrockRuntimeClient.prototype, 'send', async command => {
    assert.equal(command.input.inferenceConfig.maxTokens, 512);
    return { output: { message: { content: [{ text: 'Answer' }] } }, stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 }, $metadata: { attempts: 3, totalRetryDelay: 750 } };
  });
  await ai.invoke('ignored', body);
  assert.equal(finished()?.prompt_tokens, 50);
  assert.equal(finished().output_tokens, 10);
  assert.equal(finished().reasoning_tokens, null);
  assert.equal(finished().provider_retries, 2);
  assert.equal(finished().provider_retry_delay_ms, 750);
  assert.equal(finished().usage_complete, false);
});

test('Bedrock stream retains terminal metadata and logs cancellation when its consumer stops', async () => {
  active = { ...settings, provider: 'bedrock' };
  mock.method(BedrockRuntimeClient.prototype, 'send', async () => ({
    $metadata: { attempts: 1, totalRetryDelay: 0 },
    stream: (async function* () {
      yield { contentBlockDelta: { delta: { text: 'hello' } } };
      yield { metadata: { usage: { inputTokens: 90, outputTokens: 30 } } };
    })(),
  }));
  for await (const _event of ai.invokeStream('ignored', body)) { /* drain */ }
  assert.equal(finished()?.prompt_tokens, 90);
  assert.equal(finished().usage_complete, true);
  for await (const _event of ai.invokeStream('ignored', body)) break;
  assert.equal(finished().outcome, 'cancelled');
  assert.equal(finished().output_tokens, null);
});

test('a throwing telemetry sink never changes the provider reply or error', async () => {
  mock.method(logger, 'info', () => { throw new Error('sink unavailable'); });
  mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'Retain me' }, finish_reason: 'stop' }] }));
  assert.equal((await ai.invoke('ignored', body)).content[0].text, 'Retain me');
});

test('lesson-start enrichment inherits request context without changing plugin call signatures', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(db, 'getUserById', async () => ({ userId: 'learner', role: 'user' }));
  const originalGet = db.getSyncData;
  mock.method(db, 'getSyncData', async (user, key, ...rest) => key.startsWith('lesson:') ? { data: { status: 'public', markdown: '# Lesson\n## Exemplar\nA result\n## Learning Objectives\n- Can explain' } } : originalGet.call(db, user, key, ...rest));
  mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const unsubscribe = on('lessonStarted', async () => {
    await ai.invoke('ignored', body);
    return { context: 'An enrichment' };
  });
  const telemetry = { generation: 'reset-1', turnId: 'turn-1' };
  try {
    const response = await new Hono().route('/', sync).request('/v1/sync/lesson-started', {
      method: 'POST', headers: { ...currentClientHeaders, Authorization: `Bearer ${await signAccessToken('learner', 'user')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: 'lesson-1', lesson: {}, lessonKB: {}, telemetry }),
    });
    assert.equal(response.status, 200);
    assert.equal(finished()?.attempt_ref, inferenceContext('learner', { ...telemetry, lessonId: 'lesson-1' }).attempt_ref);
    assert.equal(finished().agent_role, 'lesson-enrichment');
    await ai.invoke('ignored', body);
    assert.equal(finished().attempt_ref, undefined, 'request context cannot leak into unrelated invocations');
  } finally { unsubscribe(); }
});

const warnings = () => logger.recent().filter(e => e.code === 'ai_provider_error');

test('a provider failure logs one content-free warning joined to its measurement', async () => {
  mock.method(console, 'warn', () => {});
  mock.method(globalThis, 'fetch', async () => new Response('secret upstream details', { status: 401 }));
  await assert.rejects(ai.invoke('ignored', body), { name: 'WorkersAiError' });
  assert.equal(warnings().length, 1);
  const [warning] = warnings();
  assert.equal(warning.level, 'warn');
  assert.equal(warning.meta.inference_id, finished().inference_id);
  assert.deepEqual({ ...warning.meta, inference_id: 'joined' }, {
    schema_version: 1, inference_id: 'joined', provider: 'workers-ai', model, stream: false, agent_role: 'unknown',
    error_code: 'ai_unavailable', stage: 'provider', reason: 'http', error_name: 'WorkersAiError', http_status: 401,
    cause_code: null, credential_source: 'environment', token_expires_in_s: null,
  });
  assert.equal(finished().error_code, 'ai_unavailable');
  assert.doesNotMatch(JSON.stringify(logger.recent()), /secret/);
});

test('missing credentials warn at the credentials stage without calling the provider', async () => {
  mock.method(console, 'warn', () => {});
  delete process.env.CLOUDFLARE_API_TOKEN;
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({}));
  await assert.rejects(ai.invoke('ignored', body), { name: 'AiConfigurationError' });
  assert.equal(fetchMock.mock.callCount(), 0);
  const { error_code, stage, reason, error_name } = warnings()[0].meta;
  assert.deepEqual({ error_code, stage, reason, error_name },
    { error_code: 'ai_unavailable', stage: 'credentials', reason: 'missing-credentials', error_name: 'AiConfigurationError' });
});

test('a failed stream warns, but a stream the caller cancels does not', async () => {
  mock.method(console, 'warn', () => {});
  mock.method(globalThis, 'fetch', async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(async () => { for await (const _event of ai.invokeStream('ignored', body)) { /* drain */ } });
  const { error_code, reason, stream } = warnings()[0].meta;
  assert.deepEqual({ error_code, reason, stream }, { error_code: 'ai_overloaded', reason: 'empty', stream: true });

  logger._reset();
  const controller = new AbortController();
  mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = (async () => {
    for await (const _event of ai.invokeStream('ignored', body, { signal: controller.signal })) { /* drain */ }
  })();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending);
  assert.equal(finished().outcome, 'cancelled');
  assert.equal(warnings().length, 0);
});

test('a throwing warning sink never changes the provider error', async () => {
  mock.method(logger, 'warn', () => { throw new Error('sink unavailable'); });
  mock.method(globalThis, 'fetch', async () => new Response('', { status: 429 }));
  await assert.rejects(ai.invoke('ignored', body), err => err.name === 'WorkersAiError' && err.status === 429);
  assert.equal(finished().error_code, 'ai_rate_limited');
});

test('an invalid or unreadable AI selection warns at the settings stage instead of failing silently', async () => {
  mock.method(console, 'warn', () => {});
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({}));
  active = { provider: 'workersai', workersAiModel: model }; // a mistyped AI_PROVIDER reaches the same check
  await assert.rejects(ai.invoke('ignored', body, { context: inferenceContext('learner', { agentRole: 'coach' }) }), { name: 'AiConfigurationError' });
  assert.deepEqual(warnings()[0].meta, {
    schema_version: 1, inference_id: null, provider: null, model: null, stream: false, agent_role: 'coach',
    error_code: 'ai_unavailable', stage: 'settings', reason: 'invalid-settings', error_name: 'AiConfigurationError',
    http_status: null, cause_code: null, credential_source: null, token_expires_in_s: null,
  });
  assert.equal(finished(), undefined, 'no provider was invoked');

  logger._reset();
  mock.method(db, 'getSyncData', async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.9.8.7:5432'), { code: 'ECONNREFUSED' }); });
  await assert.rejects(async () => { for await (const _event of ai.invokeStream('ignored', body)) { /* drain */ } }, { name: 'AiSettingsError' });
  const { stage, error_code, error_name, cause_code, stream } = warnings()[0].meta;
  assert.deepEqual({ stage, error_code, error_name, cause_code, stream },
    { stage: 'settings', error_code: 'ai_error', error_name: 'Error', cause_code: 'ECONNREFUSED', stream: true });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.doesNotMatch(JSON.stringify(logger.recent()), /10\.9\.8\.7/);
});
