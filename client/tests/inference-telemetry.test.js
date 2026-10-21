import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
globalThis.sessionStorage = { getItem: () => null };
const { initializeLessonKB, extractLessonMarkdown } = await import('../js/orchestrator.js');
const { createInferenceOperation } = await import('../js/inferenceTelemetry.js');
const validKB = { exemplar: 'Explain', objectives: [{ objective: 'Explain', evidence: 'Explanation' }], learnerPosition: 'Starting', insights: [], activitiesCompleted: 0, status: 'learning' };
let requests, responses;
beforeEach(() => {
  values.clear(); requests = []; responses = [];
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'token', user: { userId: 'learner' } }));
  mock.method(globalThis, 'fetch', async (path, options) => {
    if (path.startsWith('/v1/prompts/')) return Response.json({ content: 'prompt' });
    if (path === '/v1/sync/status') return Response.json({ protocol: '1', epoch: 'test' });
    assert.equal(path, '/v1/ai/messages');
    requests.push(JSON.parse(options.body));
    return responses.shift();
  });
});
afterEach(() => mock.restoreAll());

test('output-validation retries share an operation but each has its own retry index', async () => {
  responses = [Response.json({ content: [{ type: 'text', text: '{}' }] }), Response.json({ content: [{ type: 'text', text: JSON.stringify(validKB) }] })];
  await initializeLessonKB({ lessonId: 'lesson-1' }, '', { userId: 'learner', lessonId: 'lesson-1', generation: 'reset-1', turnId: 'turn-1' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].telemetry.operationId, requests[1].telemetry.operationId);
  assert.deepEqual(requests.map(r => r.telemetry.retryIndex), [0, 1]);
  assert.ok(requests.every(r => r.telemetry.agentRole === 'lesson-owner' && r.telemetry.generation === 'reset-1'));
  assert.ok(requests.every(r => r.max_tokens === 1536));
});

test('overload retries are counted without changing retry policy or model budgets', async () => {
  const delays = [];
  const timeout = globalThis.setTimeout;
  mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 3000 || ms === 6000) { delays.push(ms); return timeout(fn, 0, ...args); }
    return timeout(fn, ms, ...args);
  });
  responses = [Response.json({ code: 'ai_overloaded' }, { status: 503 }), Response.json({ error: 'overload' }, { status: 500 }),
    Response.json({ content: [{ type: 'text', text: '# Lesson' }] })];
  assert.equal(await extractLessonMarkdown('secret conversation'), '# Lesson');
  assert.deepEqual(delays, [3000, 6000]);
  assert.deepEqual(requests.map(r => r.telemetry.retryIndex), [0, 1, 2]);
  assert.equal(new Set(requests.map(r => r.telemetry.operationId)).size, 1);
  assert.ok(requests.every(r => r.telemetry.agentRole === 'lesson-extractor' && r.telemetry.lessonId === undefined));
});

test('queued lesson attribution cannot start inference under another signed-in account', async () => {
  const operation = createInferenceOperation('learner-profile-update', { userId: 'learner', lessonId: 'l1', generation: null, turnId: 't1' });
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'other', user: { userId: 'other' } }));
  await assert.rejects(operation.next(), /original account/);
  assert.equal(requests.length, 0);
});
