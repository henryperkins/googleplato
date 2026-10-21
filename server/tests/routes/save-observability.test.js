import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import sync from '../../src/routes/sync.js';
import db from '../../src/lib/db.js';
import { logger } from '../../src/lib/logger.js';
import { signAccessToken } from '../../src/lib/jwt.js';
import { currentClientHeaders } from '../helpers/clientCompatibility.js';
const app = new Hono().route('/', sync);
const conflict = () => { throw Object.assign(new Error('private contents'), { name: 'ConditionalCheckFailedException' }); };
beforeEach(() => {
  logger._reset();
  db.getUserById = async () => ({ userId: 'usr_private', role: 'user' });
  db.getSyncData = async () => ({ version: 2 });
  db.putSyncData = conflict;
});
async function request(path, body, headers = currentClientHeaders) {
  return app.request(path, { method: 'PUT', headers: { ...headers, Authorization: `Bearer ${await signAccessToken('usr_private', 'user')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
test('logs conditional write rejection without learner content or raw keys', async () => {
  assert.equal((await request('/v1/sync/messages:private-lesson', { data: ['secret reply'], version: 1 })).status, 409);
  const events = logger.recent().filter(e => e.code === 'sync_conflict');
  assert.equal(events.length, 1);
  assert.equal(events[0].meta.operation, 'sync_write');
  assert.equal(events[0].meta.status, 409);
  assert.doesNotMatch(JSON.stringify(events), /secret reply|private-lesson|usr_private/);
});
test('logs validation and stale-client rejection separately from data conflicts', async () => {
  assert.equal((await request('/v1/sync/profile', { data: {} })).status, 400);
  assert.equal((await request('/v1/sync/profile', { data: {}, version: 0 }, {})).status, 409);
  assert.equal(logger.recent().filter(e => e.code === 'sync_validation_failure').length, 2);
  assert.ok(logger.recent().some(e => e.meta.reason === 'client_upgrade_required'));
  assert.equal(logger.recent().filter(e => e.code === 'sync_conflict').length, 0);
});
test('logs failed batch items even though the HTTP envelope succeeds', async () => {
  const response = await request('/v1/sync/batch', { items: [
    { dataKey: 'profile', data: {}, version: 1 },
    { dataKey: 'invalid-key', data: 'private body', version: 0 },
  ] });
  assert.equal(response.status, 200);
  assert.deepEqual(logger.recent().map(e => e.code).sort(), ['sync_conflict', 'sync_validation_failure']);
});
test('generated-turn conflicts and oversized requests emit save alarms, while replay success emits only lifecycle INFO', async () => {
  const base = { generation: null, messages: { version: 0, data: [] }, lessonKB: { version: 0, data: null } };
  db.getLessonState = async () => structuredClone(base);
  const turn = { userId: 'usr_private', turnId: 'turn-1', base,
    messages: [{ id: 'turn-1:0', role: 'assistant', content: 'secret' }], lessonKB: { lessonId: 'lesson-1', startedAt: 1 } };
  const send = body => app.request('/v1/sync/lesson-turn/lesson-1', { method: 'POST', headers: postHeaders, body: JSON.stringify(body) });
  const postHeaders = { ...currentClientHeaders, 'Content-Type': 'application/json', Authorization: `Bearer ${await signAccessToken('usr_private', 'user')}` };
  assert.equal((await send({ ...turn, messages: [{ ...turn.messages[0], content: 'x'.repeat(390 * 1024) }] })).status, 413);
  db.getLessonState = async () => ({ ...base, generation: 'reset' });
  assert.equal((await send(turn)).status, 409);
  assert.deepEqual(logger.recent().map(e => e.code).sort(), ['sync_conflict', 'sync_validation_failure']);
  logger._reset();
  db.getLessonState = async () => ({ ...base, messages: { version: 1, data: turn.messages }, lessonKB: { version: 1, data: turn.lessonKB } });
  assert.equal((await send(turn)).status, 200);
  assert.equal(logger.recent().filter(event => event.level !== 'info').length, 0);
  assert.deepEqual(logger.recent().map(event => event.code), ['lesson_attempt_saved']);
});
