import { currentClientHeaders } from '../helpers/clientCompatibility.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import admin from '../../src/routes/admin.js';
import aiRoute from '../../src/routes/ai.js';
import db from '../../src/lib/db.js';
import { signAccessToken } from '../../src/lib/jwt.js';

const MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const app = new Hono().route('/', admin).route('/', aiRoute);
let saved;
let writes;
let calls;
const env = Object.fromEntries(['AI_PROVIDER', 'WORKERS_AI_MODEL', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].map(key => [key, process.env[key]]));

async function request(method, path, body, role = 'admin', compatibilityHeaders = currentClientHeaders) {
  const token = await signAccessToken(`usr_${role}`, role);
  return app.request(path, {
    method,
    headers: { ...compatibilityHeaders, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  saved = null;
  writes = 0;
  calls = [];
  delete process.env.AI_PROVIDER;
  delete process.env.WORKERS_AI_MODEL;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = 'test-token-never-return';
  mock.method(db, 'getUserById', async id => ({ userId: id, role: id === 'usr_admin' ? 'admin' : 'user' }));
  mock.method(db, 'getSyncData', async (userId, key, options) => {
    if (userId === '_integrations') return null;
    assert.equal(userId, '_system');
    assert.equal(key, 'ai-settings');
    assert.equal(options?.consistentRead, true);
    return saved;
  });
  mock.method(db, 'getSyncDataByPrefix', async (userId, prefix, options) => {
    assert.equal(userId, '_integrations');
    assert.equal(prefix, 'cloudflare-revoke:');
    assert.equal(options?.consistentRead, true);
    return [];
  });
  mock.method(db, 'putSyncData', async (userId, key, data, version, options) => {
    assert.equal(userId, '_system');
    assert.equal(key, 'ai-settings');
    assert.equal(options?.strictVersion, true);
    assert.equal(version, saved?.version || 0);
    writes++;
    saved = { data, version: version + 1 };
    return { version: saved.version };
  });
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return Response.json({
      choices: [{ message: { content: 'Connection OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    });
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('admin AI settings', () => {
  it('keeps Bedrock as the default and exposes credential presence without secrets', async () => {
    const res = await request('GET', '/v1/admin/ai-settings');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.provider, 'bedrock');
    assert.equal(data.workersAiModel, MODEL);
    assert.equal(data.workersAiCredentials.configured, true);
    assert.equal(data.version, 0);
    assert.doesNotMatch(JSON.stringify(data), /test-token-never-return|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  });

  it('forbids learners and anonymous users from reading, saving, or testing provider settings', async () => {
    for (const [method, path] of [['GET', '/v1/admin/ai-settings'], ['PUT', '/v1/admin/ai-settings'], ['POST', '/v1/admin/ai-settings/test']]) {
      assert.equal((await request(method, path, method === 'GET' ? undefined : {}, 'user')).status, 403);
      assert.equal((await app.request(path, { method })).status, 401);
    }
    assert.equal(calls.length, 0);
    assert.equal(writes, 0);
  });

  it('persists the choice and routes the next request through Cloudflare despite a stale browser model', async () => {
    const res = await request('PUT', '/v1/admin/ai-settings', { provider: 'workers-ai', workersAiModel: MODEL, version: 0 });
    assert.equal(res.status, 200);
    assert.deepEqual(saved.data, { provider: 'workers-ai', workersAiModel: MODEL });
    const reply = await request('POST', '/v1/ai/messages', {
      model: 'arbitrary-browser-model', max_tokens: 128, system: 'Be helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
    }, 'user');
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).content[0].text, 'Connection OK');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, MODEL);
    assert.equal(calls[0].body.reasoning_effort, 'max');
    assert.deepEqual(calls[0].body.messages[0], { role: 'system', content: 'Be helpful.' });
    assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1/chat/completions`);
  });

  it('rejects unknown providers, non-hosted models, and credential fields without saving', async () => {
    for (const change of [
      { provider: 'openai' },
      { workersAiModel: 'openai/gpt-4o' },
      { workersAiModel: '@cf/unknown/model' },
      { apiToken: 'do-not-store' },
    ]) {
      const res = await request('PUT', '/v1/admin/ai-settings', { provider: 'workers-ai', workersAiModel: MODEL, version: 0, ...change });
      assert.equal(res.status, 400);
    }
    assert.equal(writes, 0);
  });

  it('prevents a stale admin form from overwriting a newer choice', async () => {
    saved = { data: { provider: 'bedrock', workersAiModel: MODEL }, version: 2 };
    const res = await request('PUT', '/v1/admin/ai-settings', { provider: 'workers-ai', workersAiModel: MODEL, version: 1 });
    assert.equal(res.status, 409);
    assert.equal(writes, 0);
  });

  it('tests an unsaved provider choice without activating it', async () => {
    const res = await request('POST', '/v1/admin/ai-settings/test', { provider: 'workers-ai', workersAiModel: MODEL });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(writes, 0);
    assert.equal(saved, null);
  });

  it('fences obsolete admin model tests before inference or settings writes', async () => {
    for (const headers of [
      {},
      { ...currentClientHeaders, 'X-Plato-Client-Protocol': '0' },
      { ...currentClientHeaders, 'X-Plato-Client-Protocol': '2' },
      { ...currentClientHeaders, 'X-Plato-Client-Epoch': 'old' },
    ]) {
      const res = await request('POST', '/v1/admin/ai-settings/test', { provider: 'workers-ai', workersAiModel: MODEL }, 'admin', headers);
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, 'client_upgrade_required');
      assert.equal(calls.length, 0);
      assert.equal(writes, 0);
    }
  });

  it('reports missing Cloudflare credentials without sending an inference request', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const res = await request('POST', '/v1/admin/ai-settings/test', { provider: 'workers-ai', workersAiModel: MODEL });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'ai_unavailable');
    assert.equal(calls.length, 0);
  });

  it('returns a safe, classified Cloudflare failure for non-streaming agents', async () => {
    saved = { data: { provider: 'workers-ai', workersAiModel: MODEL }, version: 1 };
    globalThis.fetch = async () => Response.json({ success: false, errors: [{ code: 10000, message: 'private account and token details' }] }, { status: 403 });
    const res = await request('POST', '/v1/ai/messages', { model: 'qwen3-vl-235b', messages: [{ role: 'user', content: 'Hello' }] });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'ai_unavailable');
    assert.doesNotMatch(JSON.stringify(body), /private account|token details/);
  });

  it('aborts Cloudflare when the browser cancels a streaming response', async () => {
    saved = { data: { provider: 'workers-ai', workersAiModel: MODEL }, version: 1 };
    let upstreamSignal;
    let upstreamController;
    let wasAborted = false;
    globalThis.fetch = async (_url, { signal }) => {
      upstreamSignal = signal;
      return new Response(new ReadableStream({
        start(controller) {
          upstreamController = controller;
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
          signal.addEventListener('abort', () => { wasAborted = true; controller.error(signal.reason); }, { once: true });
        },
      }), { headers: { ...currentClientHeaders, 'Content-Type': 'text/event-stream' } });
    };
    const res = await request('POST', '/v1/ai/messages', { model: 'qwen3-vl-235b', stream: true, messages: [{ role: 'user', content: 'Hello' }] });
    const reader = res.body.getReader();
    try {
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('Hello')) text += decoder.decode((await reader.read()).value);
      await reader.cancel();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(upstreamSignal.aborted, true);
      assert.equal(wasAborted, true);
    } finally {
      // Ensure the pre-fix failure cannot leave a hanging model stream.
      if (!wasAborted) upstreamController.close();
    }
  });
});
