import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import workersAi, { toWorkersAiRequest } from '../../src/lib/workers-ai.js';
import { classifyAiError } from '../../src/lib/ai-errors.js';
import ai from '../../src/lib/ai-provider.js';
import bedrock from '../../src/lib/bedrock.js';
import db from '../../src/lib/db.js';

const MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const body = { max_tokens: 256, system: 'Be helpful.', messages: [{ role: 'user', content: 'Hello' }] };
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;

beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'b'.repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = 'secret-test-token';
  mock.method(db, 'getSyncData', async () => null);
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  if (account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
  else process.env.CLOUDFLARE_ACCOUNT_ID = account;
  if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = token;
});

function sse(frames, { fragmented = false } = {}) {
  const bytes = new TextEncoder().encode(frames);
  return new Response(new ReadableStream({
    start(controller) {
      if (fragmented) for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
      else controller.enqueue(bytes);
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('Cloudflare Workers AI adapter', () => {
  it('rejects invalid token budgets before adding reasoning headroom', () => {
    for (const max_tokens of ['512', -1, 0, 1.5, Infinity]) {
      assert.throws(() => toWorkersAiRequest(MODEL, { ...body, max_tokens }), { name: 'ValidationException' });
    }
  });

  it('preserves system prompts, multi-turn text and base64 images with maximum reasoning', () => {
    const request = toWorkersAiRequest(MODEL, {
      max_tokens: 512,
      system: [{ type: 'text', text: 'A coach.' }],
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'Show me.' }] },
        { role: 'user', content: [
          { type: 'text', text: 'Here' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
        ] },
      ],
    });
    assert.deepEqual(request.messages, [
      { role: 'system', content: 'A coach.' },
      { role: 'assistant', content: 'Show me.' },
      { role: 'user', content: [{ type: 'text', text: 'Here' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] },
    ]);
    assert.equal(request.model, MODEL);
    assert.equal(request.reasoning_effort, 'max');
    assert.equal(request.max_tokens, 8704);
  });

  it('rejects remote images and unsupported content instead of dropping them', () => {
    for (const content of [
      [{ type: 'image', source: { type: 'url', url: 'http://internal.example' } }],
      [{ type: 'document', source: {} }],
    ]) {
      assert.throws(() => toWorkersAiRequest(MODEL, { messages: [{ role: 'user', content }] }), { name: 'ValidationException' });
    }
  });

  it('returns only visible text, token usage and a translated truncation reason', async () => {
    mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer secret-test-token');
      return Response.json({
        choices: [{ message: { content: 'Visible answer', reasoning_content: 'Private reasoning' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 12, completion_tokens: 50 },
      });
    });
    const result = await workersAi.invoke(MODEL, body);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'Visible answer' }], usage: { input_tokens: 12, output_tokens: 50 }, stop_reason: 'max_tokens' });
  });

  it('translates fragmented UTF-8 SSE, suppresses reasoning and retains final usage', async () => {
    mock.method(globalThis, 'fetch', async () => sse([
      ': keepalive\r\n\r\n',
      'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"Café ☕"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":30}}\r\n\r\n',
      'data: [DONE]',
    ].join(''), { fragmented: true }));
    const events = await collect(workersAi.invokeStream(MODEL, body));
    assert.equal(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join(''), 'Café ☕');
    assert.equal(events.find(event => event.type === 'message_delta').delta.stop_reason, 'end_turn');
    assert.deepEqual(events.at(-1), { type: 'message_stop', usage: { input_tokens: 20, output_tokens: 30 } });
    assert.doesNotMatch(JSON.stringify(events), /hidden/);
  });

  it('rejects incomplete, empty, malformed, or failed streams', async () => {
    for (const fixture of [
      'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
      'data: not-json\n\n',
      'data: {"error":{"message":"secret upstream details","status":429}}\n\n',
    ]) {
      const fetchMock = mock.method(globalThis, 'fetch', async () => sse(fixture));
      await assert.rejects(collect(workersAi.invokeStream(MODEL, body)), err => {
        assert.doesNotMatch(err.message, /secret upstream/);
        return err.name === 'WorkersAiError';
      });
      fetchMock.mock.restore();
    }
  });

  it('cancels the upstream stream when the consumer stops reading', async () => {
    let signal;
    let cancelled = false;
    mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        },
        cancel() { cancelled = true; },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    for await (const event of workersAi.invokeStream(MODEL, body)) {
      if (event.type === 'content_block_delta') break;
    }
    assert.equal(cancelled, true);
    assert.equal(signal.aborted, true);
  });

  it('classifies Cloudflare HTTP failures without retaining upstream text', async () => {
    for (const [status, code] of [[401, 'ai_unavailable'], [403, 'ai_unavailable'], [404, 'ai_unavailable'], [429, 'ai_rate_limited'], [500, 'ai_overloaded'], [504, 'ai_timeout'], [400, 'ai_invalid_request']]) {
      const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('secret upstream details', { status }));
      await assert.rejects(workersAi.invoke(MODEL, body), err => {
        assert.equal(classifyAiError(err).code, code);
        assert.doesNotMatch(err.message, /secret upstream/);
        return true;
      });
      fetchMock.mock.restore();
    }
  });

  it('times out an upstream request using an abort signal', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const result = assert.rejects(workersAi.invoke(MODEL, body), err => classifyAiError(err).code === 'ai_timeout');
    mock.timers.tick(115000);
    await result;
  });
});

describe('provider selection', () => {
  it('switches back to Bedrock on the next request without trusting the caller model', async () => {
    let selected = 'workers-ai';
    mock.method(db, 'getSyncData', async () => ({ data: { provider: selected, workersAiModel: MODEL }, version: 1 }));
    mock.method(workersAi, 'invoke', async () => ({ provider: 'workers-ai' }));
    mock.method(bedrock, 'invoke', async model => ({ provider: 'bedrock', model }));
    assert.deepEqual(await ai.invoke('malicious-model', body), { provider: 'workers-ai' });
    selected = 'bedrock';
    assert.deepEqual(await ai.invoke('malicious-model', body), { provider: 'bedrock', model: 'qwen3-vl-235b' });
  });

  it('streams through the saved provider and never falls back after a Cloudflare error', async () => {
    mock.method(db, 'getSyncData', async (userId) => userId === '_system' ? ({ data: { provider: 'workers-ai', workersAiModel: MODEL }, version: 1 }) : null);
    mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
    let bedrockCalls = 0;
    mock.method(bedrock, 'invokeStream', async function* () { bedrockCalls++; yield {}; });
    await assert.rejects(collect(ai.invokeStream('qwen3-vl-235b', body)), { name: 'WorkersAiError' });
    assert.equal(bedrockCalls, 0);
  });
});
