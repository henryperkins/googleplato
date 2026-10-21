import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.CLIENT_COMPATIBILITY_EPOCH = 'epoch-a';
const { Hono } = await import('hono');
const { default: db } = await import('../../src/lib/db.js');
const { default: sync } = await import('../../src/routes/sync.js');
const { default: ai } = await import('../../src/routes/ai.js');
const { default: provider } = await import('../../src/lib/ai-provider.js');
const { signAccessToken } = await import('../../src/lib/jwt.js');
const app = new Hono().route('/', sync).route('/', ai);
const userId = 'upgrade-learner';
const current = { 'X-Plato-Client-Protocol': '1', 'X-Plato-Client-Epoch': 'epoch-a' };
let modelCalls;

async function request(method, path, body, headers = current) {
  return app.request(path, { method,
    headers: { Authorization: `Bearer ${await signAccessToken(userId, 'user')}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(async () => {
  process.env.CLIENT_COMPATIBILITY_EPOCH = 'epoch-a';
  if (!await db.getUserById(userId)) await db.createUser({ userId, email: 'upgrade@example.test', passwordHash: 'x', name: 'Learner', role: 'user' });
  for (const record of await db.getAllSyncData(userId)) await db.deleteSyncData(userId, record.dataKey);
  await db.putSyncData(userId, 'profile', { name: 'Saved' }, 0);
  modelCalls = 0;
  provider.invoke = async () => { modelCalls++; return { content: [{ type: 'text', text: 'Reply' }] }; };
  provider.invokeStream = async function* () { modelCalls++; yield { type: 'message_stop' }; };
});

test('obsolete clients cannot mutate any sync surface or invoke either AI transport', async () => {
  const baseline = await db.getAllSyncData(userId);
  const surfaces = [
    ['PUT', '/v1/sync/profile', { data: { name: 'Stale' }, version: 0 }],
    ['PUT', '/v1/sync/batch', { items: [{ dataKey: 'profile', data: {}, version: 0 }] }],
    ['DELETE', '/v1/sync/profile'], ['DELETE', '/v1/sync'],
    ['POST', '/v1/sync/lesson-turn/lesson-1', {}],
    ['POST', '/v1/sync/lesson-started', { lessonId: 'lesson-1' }],
    ...[false, true].map(stream => ['POST', '/v1/ai/messages', { model: 'test', messages: [{ role: 'user', content: 'Hi' }], stream }]),
  ];
  for (const headers of [{}, { ...current, 'X-Plato-Client-Protocol': '0' }, { ...current, 'X-Plato-Client-Protocol': '99' },
    { ...current, 'X-Plato-Client-Protocol': '1.0' }, { ...current, 'X-Plato-Client-Epoch': 'older' }]) {
    for (const [method, path, body] of surfaces) {
      const response = await request(method, path, body, headers);
      assert.equal(response.status, 409, `${method} ${path}`);
      assert.equal((await response.json()).code, 'client_upgrade_required');
    }
  }
  assert.deepEqual(await db.getAllSyncData(userId), baseline);
  assert.equal(modelCalls, 0);
});

test('capabilities and recovery reads remain available to authenticated older clients', async () => {
  const response = await request('GET', '/v1/sync/status', undefined, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { protocol: '1', epoch: 'epoch-a' });
  assert.equal((await request('GET', '/v1/sync/profile', undefined, {})).status, 200);
  assert.equal((await app.request('/v1/sync/status')).status, 401);
});

test('an epoch change rejects a previously compatible client before inference', async () => {
  process.env.CLIENT_COMPATIBILITY_EPOCH = 'epoch-b';
  const response = await request('POST', '/v1/ai/messages', { model: 'test', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(response.status, 409);
  assert.equal(modelCalls, 0);
  const upgraded = await request('POST', '/v1/ai/messages', { model: 'test', messages: [{ role: 'user', content: 'Hi' }] }, { ...current, 'X-Plato-Client-Epoch': 'epoch-b' });
  assert.equal(upgraded.status, 200);
  assert.equal(modelCalls, 1);
});

test('generic writes require an explicit nonnegative safe integer version', async () => {
  const baseline = await db.getSyncData(userId, 'profile');
  for (const version of [undefined, null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const response = await request('PUT', '/v1/sync/profile', { data: { name: 'Stale' }, version });
    assert.equal(response.status, 400, `version ${version}`);
  }
  assert.deepEqual(await db.getSyncData(userId, 'profile'), baseline);
});

test('strict creation and updates cannot overwrite or recreate missing records', async () => {
  assert.equal((await request('PUT', '/v1/sync/profile', { data: { name: 'Stale' }, version: 0 })).status, 409);
  assert.equal((await request('PUT', '/v1/sync/work', { data: [], version: 4 })).status, 409);
  assert.equal(await db.getSyncData(userId, 'work'), null);
  const results = await Promise.all([1, 2].map(n => request('PUT', '/v1/sync/profile', { data: { name: `Writer ${n}` }, version: 1 })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await db.getSyncData(userId, 'profile')).version, 2);
});

test('batch writes enforce the same conditions and validate versions before effects', async () => {
  const invalid = await request('PUT', '/v1/sync/batch', { items: [
    { dataKey: 'work', data: [], version: 0 }, { dataKey: 'profile', data: {}, version: '1' },
  ] });
  assert.equal(invalid.status, 400);
  assert.equal(await db.getSyncData(userId, 'work'), null);
  const response = await request('PUT', '/v1/sync/batch', { items: [
    { dataKey: 'profile', data: { name: 'Stale' }, version: 0 }, { dataKey: 'work', data: [], version: 3 },
  ] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results.map(r => r.status), ['conflict', 'conflict']);
  assert.equal((await db.getSyncData(userId, 'profile')).data.name, 'Saved');
  assert.equal(await db.getSyncData(userId, 'work'), null);
});
