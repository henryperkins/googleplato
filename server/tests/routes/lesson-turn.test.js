import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { Hono } = await import('hono');
const { default: db } = await import('../../src/lib/db.js');
const { default: sync } = await import('../../src/routes/sync.js');
const { signAccessToken } = await import('../../src/lib/jwt.js');
const app = new Hono().route('/', sync);
const userId = 'usr_turn_test';
const base = { generation: null, messages: { data: [], version: 0 }, lessonKB: { data: null, version: 0 } };
const turn = () => ({
  userId, turnId: 'turn-1', base: structuredClone(base),
  messages: [{ id: 'turn-1:0', role: 'assistant', content: 'A generated opening.', timestamp: 100 }],
  lessonKB: { lessonId: 'lesson-1', startedAt: 100, progress: 1, status: 'learning' },
});
async function request(method, body, suffix = '') {
  return app.request(`/v1/sync/lesson-turn/lesson-1${suffix}`, {
    method, headers: { Authorization: `Bearer ${await signAccessToken(userId, 'user')}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(async () => {
  await db.deleteSyncData(userId, 'messages:lesson-1');
  await db.deleteSyncData(userId, 'lessonKB:lesson-1');
  await db.deleteSyncData(userId, 'lessonGeneration:lesson-1');
  if (!await db.getUserById(userId)) await db.createUser({ userId, email: 'turn@example.test', passwordHash: 'x', name: 'Learner', role: 'user' });
});

test('commits the generated conversation and progress together, then acknowledges the same retry', async () => {
  const response = await request('POST', turn());
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.messages.data[0].content, 'A generated opening.');
  assert.equal(saved.lessonKB.data.progress, 1);
  const replay = await request('POST', turn());
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).messages.version, saved.messages.version);
  assert.equal((await db.getSyncData(userId, 'messages:lesson-1')).data.length, 1);
});

test('refuses a stale turn without overwriting either record', async () => {
  await db.putSyncData(userId, 'lessonKB:lesson-1', { startedAt: 200, progress: 7 }, 0);
  const response = await request('POST', turn());
  assert.equal(response.status, 409);
  assert.equal(await db.getSyncData(userId, 'messages:lesson-1'), null);
  assert.equal((await db.getSyncData(userId, 'lessonKB:lesson-1')).data.progress, 7);
});

test('reused message identities with different contents are rejected', async () => {
  assert.equal((await request('POST', turn())).status, 200);
  const changed = turn();
  changed.messages[0].content = 'A different reply';
  assert.equal((await request('POST', changed)).status, 409);
  assert.equal((await db.getSyncData(userId, 'messages:lesson-1')).data[0].content, 'A generated opening.');
});

test('a retained reply cannot be written to a different signed-in account or an impersonated view', async () => {
  assert.equal((await request('POST', { ...turn(), userId: 'someone-else' })).status, 403);
  assert.equal((await request('POST', turn(), '?asUserId=someone-else')).status, 403);
  assert.equal(await db.getSyncData(userId, 'messages:lesson-1'), null);
});

test('rejects invalid turn identity and oversized conversation before writing progress', async () => {
  const invalid = turn();
  invalid.messages[0].id = 'unrelated';
  assert.equal((await request('POST', invalid)).status, 400);
  const oversized = turn();
  oversized.messages[0].content = 'x'.repeat(390 * 1024);
  assert.equal((await request('POST', oversized)).status, 413);
  assert.equal(await db.getSyncData(userId, 'lessonKB:lesson-1'), null);
});

test('loads a fresh snapshot and does not resurrect a reset lesson on replay', async () => {
  assert.equal((await request('POST', turn())).status, 200);
  const snapshot = await request('GET');
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).messages.data.length, 1);
  const next = turn();
  next.turnId = 'turn-2';
  next.messages = [{ id: 'turn-2:0', role: 'user', content: 'Answer' }, { id: 'turn-2:1', role: 'assistant', content: 'Feedback' }];
  next.base = await (await request('GET')).json();
  await db.deleteSyncData(userId, 'messages:lesson-1');
  await db.deleteSyncData(userId, 'lessonKB:lesson-1');
  assert.equal((await request('POST', next)).status, 409);
  assert.equal(await db.getSyncData(userId, 'lessonKB:lesson-1'), null);
});

test('SQLite rolls back both records when the second record changed after the read', async () => {
  assert.equal(typeof db.commitLessonTurn, 'function');
  await db.putSyncData(userId, 'lessonKB:lesson-1', { progress: 8 }, 0);
  await assert.rejects(db.commitLessonTurn(userId, 'lesson-1', base, {
    messages: turn().messages, lessonKB: turn().lessonKB,
  }), { name: 'ConditionalCheckFailedException' });
  assert.equal(await db.getSyncData(userId, 'messages:lesson-1'), null);
  assert.equal((await db.getSyncData(userId, 'lessonKB:lesson-1')).data.progress, 8);
});

test('a lost opening acknowledgement cannot resurrect a lesson reset in another tab', async () => {
  const opening = turn();
  assert.equal((await request('POST', opening)).status, 200);
  for (const name of ['lessonKB', 'messages']) {
    const response = await app.request(`/v1/sync/${name}:lesson-1`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${await signAccessToken(userId, 'user')}` },
    });
    assert.equal(response.status, 200);
  }
  assert.equal((await request('POST', opening)).status, 409);
  assert.equal(await db.getSyncData(userId, 'messages:lesson-1'), null);
  const fresh = turn();
  fresh.base = await (await request('GET')).json();
  fresh.turnId = 'fresh-opening'; fresh.messages[0].id = 'fresh-opening:0';
  assert.equal((await request('POST', fresh)).status, 200, 'a new lesson can start after reset');
});
