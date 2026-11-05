import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { currentClientHeaders } from '../helpers/clientCompatibility.js';
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { Hono } = await import('hono');
const { default: db } = await import('../../src/lib/db.js');
const { default: admin } = await import('../../src/routes/admin.js');
const { default: sync } = await import('../../src/routes/sync.js');
const { default: ai } = await import('../../src/lib/ai-provider.js');
const { signAccessToken } = await import('../../src/lib/jwt.js');
const { signCoachTurn } = await import('../../src/lib/coach-receipt.js');
const { storeCoachResult } = await import('../../src/lib/coach-recovery.js');
const { recoverCoachTurn } = await import('../../src/lib/lesson-coaching.js');
const app = new Hono().route('/', admin).route('/', sync);
const learner = 'usr_continuity';
const operator = 'usr_operator';
const path = `/v1/admin/users/${learner}/lessons/audit/continuity-repair`;
const misleading = 'First message was an ambiguous note about CSS not loading; no audit evidence yet.';
const messages = [
  { id: 'opening:0', role: 'assistant', content: 'Audit https://www.berkshirehathaway.com on your phone.' },
  { id: 'resumed:0', role: 'user', content: 'It looks like css is ignored', assessmentProvenance: 'server-v1' },
  { id: 'resumed:1', role: 'assistant', content: 'The task is https://news.ycombinator.com.', assessmentProvenance: 'server-v1' },
];
let inferenceCalls;
beforeEach(async () => {
  for (const id of [learner, operator]) {
    if (!await db.getUserById(id)) await db.createUser({ userId: id, email: `${id}@example.test`, passwordHash: 'x', role: id === operator ? 'admin' : 'user' });
    for (const item of await db.getAllSyncData(id)) await db.deleteSyncData(id, item.dataKey);
  }
  await db.putSyncData(learner, 'messages:audit', structuredClone(messages));
  await db.putSyncData(learner, 'lessonKB:audit', { lessonId: 'audit', startedAt: 1, status: 'active', progress: 3,
    activitiesCompleted: 1, evidence: [{ objectiveId: 'existing', status: 'partial', observation: 'Prior work.', sourceIds: ['prior:0'] }],
    exemplarEvidence: { status: 'missing', observation: '', sourceIds: [] }, sources: [], insights: ['A valid prior observation.', misleading],
    learnerPosition: 'The learner reported a failed stylesheet.' });
  inferenceCalls = 0;
  ai.invoke = ai.invokeStream = () => { inferenceCalls++; throw new Error('Repair must not invoke a model.'); };
});

async function request(body, userId = operator, targetPath = path) {
  return app.request(targetPath, { method: 'POST', headers: { ...currentClientHeaders, 'Content-Type': 'application/json',
    ...(userId ? { Authorization: `Bearer ${await signAccessToken(userId, userId === operator ? 'admin' : 'user')}` } : {}) }, body: JSON.stringify(body) });
}
async function input() {
  return { base: await db.getLessonState(learner, 'audit'), assignmentMessageId: 'opening:0', learnerMessageId: 'resumed:0', misleadingInsights: [misleading] };
}

test('admin repair preserves transcript and assessment while correcting only named observations', async () => {
  const body = await input();
  const response = await request(body);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(saved.messages.data, messages);
  for (const key of ['progress', 'evidence', 'exemplarEvidence', 'sources', 'activitiesCompleted', 'startedAt', 'status']) {
    assert.deepEqual(saved.lessonKB.data[key], body.base.lessonKB.data[key]);
  }
  assert.deepEqual(saved.lessonKB.data.insights, ['A valid prior observation.']);
  assert.match(saved.lessonKB.data.learnerPosition, /It looks like css is ignored/);
  assert.doesNotMatch(saved.lessonKB.data.learnerPosition, /failed stylesheet/);
  assert.equal(saved.lessonKB.data.conversationState.assignment.sourceMessageId, 'opening:0');
  assert.equal(saved.lessonKB.data.conversationState.correction.afterMessageId, 'resumed:1');
  assert.equal(saved.lessonKB.data.conversationState.assignment.provenance, 'legacy-unverified');
  assert.equal(inferenceCalls, 0);
});

test('repair requires admin authentication and rejects impersonation writes', async () => {
  const body = await input();
  assert.equal((await request(body, null)).status, 401);
  assert.equal((await request(body, learner)).status, 403);
  assert.equal((await request(body, operator, path + '?asUserId=' + learner)).status, 403);
  assert.deepEqual(await db.getLessonState(learner, 'audit'), body.base);
});

test('a stale snapshot cannot repair over a newer learner turn', async () => {
  const body = await input();
  await db.putSyncData(learner, 'messages:audit', [...messages, { id: 'later:0', role: 'user', content: 'New work.' }]);
  assert.equal((await request(body)).status, 409);
  assert.equal((await db.getLessonState(learner, 'audit')).messages.data.at(-1).content, 'New work.');
});

test('repair refuses invented sources, unknown notes, oversized input and completed assessments', async () => {
  const body = await input();
  for (const patch of [{ assignmentMessageId: 'missing' }, { assignmentMessageId: 'resumed:0' }, { learnerMessageId: 'opening:0' },
    { misleadingInsights: ['A note that does not exist.'] }, { misleadingInsights: ['x'.repeat(301)] }, { unexpected: true }]) {
    assert.equal((await request({ ...body, ...patch })).status, 400, JSON.stringify(patch));
    assert.deepEqual(await db.getLessonState(learner, 'audit'), body.base);
  }
  await db.putSyncData(learner, 'lessonKB:audit', { ...body.base.lessonKB.data, status: 'completed', progress: 10 });
  assert.equal((await request(await input())).status, 409);
});

test('repair never ignores a concurrent commit at the atomic write boundary', async () => {
  const body = await input();
  const original = db.commitLessonTurn;
  db.commitLessonTurn = async (...args) => {
    await db.putSyncData(learner, 'messages:audit', [...messages, { id: 'race:0', role: 'user', content: 'Concurrent work.' }]);
    return original.apply(db, args);
  };
  try { assert.equal((await request(body)).status, 409); }
  finally { db.commitLessonTurn = original; }
  const saved = await db.getLessonState(learner, 'audit');
  assert.equal(saved.messages.data.at(-1).content, 'Concurrent work.');
  assert.equal(saved.lessonKB.data.learnerPosition, body.base.lessonKB.data.learnerPosition);
});

test('recovery and old receipt replay cannot restore notes changed by a repair', async () => {
  const savedBefore = await db.getLessonState(learner, 'audit');
  const turn = { userId: learner, lessonId: 'audit', turnId: 'resumed',
    base: { ...savedBefore, messages: { ...savedBefore.messages, data: [messages[0]], version: 0 }, lessonKB: { data: null, version: 0 } },
    messages: messages.slice(1), lessonKB: savedBefore.lessonKB.data, phase: 'learning', achieved: false };
  turn.receipt = signCoachTurn(turn);
  await storeCoachResult(turn);
  assert.ok(await recoverCoachTurn(learner, 'audit'));
  assert.equal((await request(await input())).status, 200);
  const repaired = await db.getLessonState(learner, 'audit');
  assert.equal(await recoverCoachTurn(learner, 'audit'), null);
  const replay = await request(turn, learner, '/v1/sync/lesson-turn/audit');
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), repaired);
  assert.deepEqual(await db.getLessonState(learner, 'audit'), repaired);
  assert.equal(inferenceCalls, 0);
});

test('an uncommitted reply from before a repair stays conflicted and unavailable for recovery', async () => {
  const base = await db.getLessonState(learner, 'audit');
  const turn = { userId: learner, lessonId: 'audit', turnId: 'pending', base,
    messages: [{ id: 'pending:0', role: 'user', content: 'Another question.' }, { id: 'pending:1', role: 'assistant', content: 'A stale answer.', assessmentProvenance: 'server-v1' }],
    lessonKB: base.lessonKB.data, phase: 'learning', achieved: false };
  turn.receipt = signCoachTurn(turn);
  await storeCoachResult(turn);
  assert.ok(await recoverCoachTurn(learner, 'audit'));
  assert.equal((await request(await input())).status, 200);
  assert.equal(await recoverCoachTurn(learner, 'audit'), null);
  assert.equal((await request(turn, learner, '/v1/sync/lesson-turn/audit')).status, 409);
});
