import { currentClientHeaders } from '../helpers/clientCompatibility.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signCoachTurn } from '../../src/lib/coach-receipt.js';
import { Hono } from 'hono';
import sync from '../../src/routes/sync.js';
import db from '../../src/lib/db.js';
import { signAccessToken } from '../../src/lib/jwt.js';

// Simulates the adapter contract for GET /v1/sync: rows matching an
// excluded prefix are never returned by the query (PR-8).
function honoringExclude(items) {
  return async (_uid, { excludePrefixes = [] } = {}) =>
    items.filter((i) => !excludePrefixes.some((p) => i.dataKey?.startsWith(p)));
}

async function authedReq(app, method, path, body) {
  const token = await signAccessToken('usr_test', 'user');
  return app.request(path, {
    method,
    headers: { ...currentClientHeaders, 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /v1/sync', () => {
  beforeEach(() => {
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
  });

  it('returns all sync data', async () => {
    db.getAllSyncData = honoringExclude([
      { dataKey: 'profile', data: { name: 'Test' }, version: 1, updatedAt: '2024-01-01T00:00:00Z' },
    ]);
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'GET', '/v1/sync');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].dataKey, 'profile');
  });

  it('filters out plugin userMeta:* records (admin-only by convention)', async () => {
    db.getAllSyncData = honoringExclude([
      { dataKey: 'profile', data: { name: 'T' }, version: 1, updatedAt: '2024-01-01T00:00:00Z' },
      { dataKey: 'userMeta:teacher-comments', data: { text: 'private' }, version: 1, updatedAt: '2024-01-01T00:00:00Z' },
      { dataKey: 'userMeta:other-plugin', data: { stuff: 'also private' }, version: 1, updatedAt: '2024-01-01T00:00:00Z' },
      { dataKey: 'preferences', data: { theme: 'dark' }, version: 1, updatedAt: '2024-01-01T00:00:00Z' },
    ]);
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'GET', '/v1/sync');
    const data = await res.json();
    const keys = data.map((d) => d.dataKey).sort();
    assert.deepEqual(keys, ['preferences', 'profile'], 'userMeta:* must be hidden from learners');
  });

  it('filters out screenshot:* records (fetched on demand, not in the bulk payload)', async () => {
    db.getAllSyncData = honoringExclude([
      { dataKey: 'messages:wp-1', data: [], version: 1, updatedAt: '2024-01-01T00:00:00Z' },
      { dataKey: 'screenshot:lesson-wp-1-0', data: 'data:image/jpeg;base64,abc', version: 1, updatedAt: '2024-01-01T00:00:00Z' },
      { dataKey: 'screenshot:lesson-wp-2-0', data: 'data:image/jpeg;base64,def', version: 1, updatedAt: '2024-01-01T00:00:00Z' },
    ]);
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'GET', '/v1/sync');
    const data = await res.json();
    const keys = data.map((d) => d.dataKey);
    assert.deepEqual(keys, ['messages:wp-1'], 'screenshot:* must stay out of the bulk sync payload');
  });

  it('asks the adapter to exclude screenshots, userMeta and lessonGeneration in the query', async () => {
    let seenOptions;
    db.getAllSyncData = async (_uid, options) => {
      seenOptions = options;
      return [{ dataKey: 'profile', data: { name: 'T' }, version: 1, updatedAt: '2024-01-01T00:00:00Z' }];
    };
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'GET', '/v1/sync');
    assert.equal(res.status, 200);
    assert.deepEqual(seenOptions, { excludePrefixes: ['screenshot:', 'userMeta:', 'lessonGeneration:', 'coachResult:', 'coachAttempt:'] });
    const data = await res.json();
    assert.deepEqual(data, [{ dataKey: 'profile', data: { name: 'T' }, version: 1, updatedAt: '2024-01-01T00:00:00Z' }]);
  });
});

describe('PUT /v1/sync/:dataKey', () => {
  beforeEach(() => {
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
  });

  it('upserts data', async () => {
    db.putSyncData = async () => ({ version: 2, updatedAt: '2024-01-01T00:00:00Z' });
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/profile', { data: { name: 'Test' }, version: 1 });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.version, 2);
  });

  it('returns 409 on version conflict', async () => {
    const err = new Error('conflict');
    err.name = 'ConditionalCheckFailedException';
    db.putSyncData = async () => { throw err; };
    db.getSyncData = async () => ({ version: 5 });
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/profile', { data: { name: 'Test' }, version: 1 });
    assert.equal(res.status, 409);
    const result = await res.json();
    assert.equal(result.serverVersion, 5);
  });

  it('rejects invalid dataKey', async () => {
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/invalid-key', { data: {} });
    assert.equal(res.status, 400);
  });

  it('accepts screenshot:<key> records (pasted images persist one-per-record)', async () => {
    db.getSyncData = async () => null;
    db.putSyncData = async () => ({ version: 1, updatedAt: '2024-01-01T00:00:00Z' });
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/screenshot:lesson-wp-1700000000000-0', {
      data: 'data:image/jpeg;base64,abc', version: 0,
    });
    assert.equal(res.status, 200);
  });

  it('accepts progress:lessonId keys', async () => {
    db.putSyncData = async () => ({ version: 1, updatedAt: '2024-01-01T00:00:00Z' });
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/progress:basics-wordpress', { data: {}, version: 0 });
    assert.equal(res.status, 200);
  });

  it('accepts courseProgress:<courseId> keys (cross-lesson progress note)', async () => {
    db.putSyncData = async () => ({ version: 1, updatedAt: '2024-01-01T00:00:00Z' });
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/courseProgress:course-abc', {
      data: { courseId: 'course-abc', summary: 'Learner has built a clear intro.', completedLessonIds: ['l1'] },
      version: 0,
    });
    assert.equal(res.status, 200);
  });

  it('rejects a bare courseProgress key with no course id', async () => {
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/courseProgress:', { data: {} });
    assert.equal(res.status, 400);
  });
});

describe('PUT /v1/sync/batch', () => {
  beforeEach(() => {
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
  });

  it('processes batch items', async () => {
    db.putSyncData = async () => ({ version: 2, updatedAt: '2024-01-01T00:00:00Z' });
    db.updateUser = async () => {};
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/batch', {
      items: [
        { dataKey: 'profile', data: { x: 1 }, version: 1 },
        { dataKey: 'preferences', data: { name: 'A' }, version: 0 },
      ],
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].status, 'ok');
  });

  it('writes items sequentially, never in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    db.putSyncData = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return { version: 2, updatedAt: '2024-01-01T00:00:00Z' };
    };
    db.updateUser = async () => {};
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/batch', {
      items: [
        { dataKey: 'profile', data: { x: 1 }, version: 1 },
        { dataKey: 'preferences', data: { x: 2 }, version: 0 },
        { dataKey: 'work', data: { x: 3 }, version: 0 },
      ],
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.deepEqual(result.results.map(r => r.status), ['ok', 'ok', 'ok']);
    assert.equal(maxInFlight, 1, 'batch items must not hold pool clients in parallel');
  });

  it('keeps per-item conflict results and continues past them', async () => {
    const conflict = new Error('conflict');
    conflict.name = 'ConditionalCheckFailedException';
    db.putSyncData = async (_uid, dataKey) => {
      if (dataKey === 'profile') throw conflict;
      return { version: 3, updatedAt: '2024-01-01T00:00:00Z' };
    };
    db.getSyncData = async () => ({ version: 7 });
    db.updateUser = async () => {};
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/batch', {
      items: [
        { dataKey: 'profile', data: { x: 1 }, version: 1 },
        { dataKey: 'preferences', data: { x: 2 }, version: 0 },
      ],
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.deepEqual(result.results, [
      { dataKey: 'profile', status: 'conflict', code: 'sync_conflict', serverVersion: 7 },
      { dataKey: 'preferences', status: 'ok', version: 3 },
    ]);
  });

  it('rejects an oversize screenshot per-item without writing it', async () => {
    db.getSyncData = async () => null;
    const written = [];
    db.putSyncData = async (_uid, dataKey) => { written.push(dataKey); return { version: 1, updatedAt: '2024-01-01T00:00:00Z' }; };
    db.updateUser = async () => {};
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/batch', {
      items: [
        { dataKey: 'screenshot:big', data: 'x'.repeat(500_000), version: 0 },
        { dataKey: 'profile', data: { x: 1 }, version: 0 },
      ],
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.results[0].status, 'error');
    assert.equal(result.results[0].error, 'Screenshot too large');
    assert.equal(result.results[1].status, 'ok');
    assert.deepEqual(written, ['profile']);
  });

  it('does not attempt items after an unexpected error', async () => {
    const attempted = [];
    db.putSyncData = async (_uid, dataKey) => {
      attempted.push(dataKey);
      throw new Error('db exploded');
    };
    db.updateUser = async () => {};
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'PUT', '/v1/sync/batch', {
      items: [
        { dataKey: 'profile', data: { x: 1 }, version: 0 },
        { dataKey: 'preferences', data: { x: 2 }, version: 0 },
      ],
    });
    assert.equal(res.status, 500, 'unexpected errors still fail the request');
    assert.deepEqual(attempted, ['profile'], 'later items are not attempted after a failure');
  });
});

describe('DELETE /v1/sync', () => {
  beforeEach(() => {
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
  });

  it('deletes all sync data', async () => {
    const deleted = [];
    db.getAllSyncData = async () => [
      { dataKey: 'profile' },
      { dataKey: 'work' },
      { dataKey: 'preferences' },
    ];
    db.deleteSyncData = async (_uid, key) => { deleted.push(key); };
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'DELETE', '/v1/sync');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.deleted, 3);
    assert.deepEqual(deleted, ['profile', 'work', 'preferences']);
  });

  it('returns 0 when no sync data exists', async () => {
    db.getAllSyncData = async () => [];
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'DELETE', '/v1/sync');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.deleted, 0);
  });

  it('preserves plugin-owned userMeta:* records (admin-maintained, not learner-deletable)', async () => {
    const deleted = [];
    db.getAllSyncData = async () => [
      { dataKey: 'profile' },
      { dataKey: 'userMeta:teacher-comments' },
      { dataKey: 'work' },
      { dataKey: 'userMeta:other-plugin' },
    ];
    db.deleteSyncData = async (_uid, key) => { deleted.push(key); };
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'DELETE', '/v1/sync');
    assert.equal(res.status, 200);
    const data = await res.json();
    // Only the learner's own keys deleted; admin-maintained userMeta:* survives.
    assert.deepEqual(deleted.sort(), ['profile', 'work']);
    assert.equal(data.deleted, 2, 'response count reflects what actually got deleted');
  });
});

describe('DELETE /v1/sync/:dataKey', () => {
  beforeEach(() => {
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
  });

  it('deletes sync data', async () => {
    let deleted = false;
    db.deleteSyncData = async () => { deleted = true; };
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'DELETE', '/v1/sync/profile');
    assert.equal(res.status, 200);
    assert.ok(deleted);
  });
});

// "View as User" admin feature: ?asUserId=<id> on GET routes scopes the
// read to another user. Writes are always rejected when the param is
// present — the admin's own JWT is the only thing allowed to mutate.
describe('?asUserId= (admin View as User)', () => {
  async function adminReq(app, method, path, body) {
    const token = await signAccessToken('usr_admin', 'admin');
    return app.request(path, {
      method,
      headers: { ...currentClientHeaders, 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  async function userReq(app, method, path, body) {
    const token = await signAccessToken('usr_test', 'user');
    return app.request(path, {
      method,
      headers: { ...currentClientHeaders, 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it('GET /v1/sync as admin with ?asUserId= reads target user data', async () => {
    db.getUserById = async (id) => ({ userId: id, role: id === 'usr_admin' ? 'admin' : 'user' });
    let queriedUserId = null;
    db.getAllSyncData = async (uid) => {
      queriedUserId = uid;
      return [{ dataKey: 'profile', data: { name: 'Target' }, version: 1, updatedAt: '2024-01-01T00:00:00Z' }];
    };
    const app = new Hono();
    app.route('/', sync);
    const res = await adminReq(app, 'GET', '/v1/sync?asUserId=usr_target');
    assert.equal(res.status, 200);
    assert.equal(queriedUserId, 'usr_target', 'DB read scoped to impersonated user');
  });

  it('GET /v1/sync/:dataKey as admin with ?asUserId= reads target item', async () => {
    db.getUserById = async (id) => ({ userId: id, role: 'admin' });
    let queriedUserId = null;
    db.getSyncData = async (uid, key) => {
      queriedUserId = uid;
      return { dataKey: key, data: { name: 'X' }, version: 1, updatedAt: '2024-01-01T00:00:00Z' };
    };
    const app = new Hono();
    app.route('/', sync);
    const res = await adminReq(app, 'GET', '/v1/sync/profile?asUserId=usr_target');
    assert.equal(res.status, 200);
    assert.equal(queriedUserId, 'usr_target');
  });

  it('GET /v1/sync as non-admin with ?asUserId= returns 403', async () => {
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
    const app = new Hono();
    app.route('/', sync);
    const res = await userReq(app, 'GET', '/v1/sync?asUserId=usr_target');
    assert.equal(res.status, 403);
  });

  it('PUT /v1/sync/:dataKey as admin with ?asUserId= returns 403', async () => {
    db.getUserById = async () => ({ userId: 'usr_admin', role: 'admin' });
    const app = new Hono();
    app.route('/', sync);
    const res = await adminReq(app, 'PUT', '/v1/sync/profile?asUserId=usr_target', { data: { name: 'X' } });
    assert.equal(res.status, 403);
  });

  it('PUT /v1/sync/batch as admin with ?asUserId= returns 403', async () => {
    db.getUserById = async () => ({ userId: 'usr_admin', role: 'admin' });
    const app = new Hono();
    app.route('/', sync);
    const res = await adminReq(app, 'PUT', '/v1/sync/batch?asUserId=usr_target', {
      items: [{ dataKey: 'profile', data: {}, version: 0 }],
    });
    assert.equal(res.status, 403);
  });

  it('DELETE /v1/sync as admin with ?asUserId= returns 403', async () => {
    db.getUserById = async () => ({ userId: 'usr_admin', role: 'admin' });
    const app = new Hono();
    app.route('/', sync);
    const res = await adminReq(app, 'DELETE', '/v1/sync?asUserId=usr_target');
    assert.equal(res.status, 403);
  });

  it('DELETE /v1/sync/:dataKey as admin with ?asUserId= returns 403', async () => {
    db.getUserById = async () => ({ userId: 'usr_admin', role: 'admin' });
    const app = new Hono();
    app.route('/', sync);
    const res = await adminReq(app, 'DELETE', '/v1/sync/profile?asUserId=usr_target');
    assert.equal(res.status, 403);
  });
});

describe('signed lesson-turn activity counter hooks (#136)', () => {
  async function commitFixture(app, method, path, body) {
    if (!/\/(lessonKB|messages):/.test(path)) return authedReq(app, method, path, body);
    const lessonId = path.split(':').at(-1);
    let prior;
    try { prior = (await db.getSyncData('usr_test', `lessonKB:${lessonId}`))?.data; } catch { prior = null; }
    const base = { generation: null, messages: { data: [], version: 0 }, lessonKB: { data: { lessonId, startedAt: 1, ...prior }, version: 1 } };
    db.getLessonState = async () => structuredClone(base);
    db.commitLessonTurn = async (_user, _lesson, _base, desired) => ({ generation: null, messages: { data: desired.messages, version: 1 }, lessonKB: { data: desired.lessonKB, version: 2 } });
    const turn = { userId: 'usr_test', lessonId, turnId: 'counter-turn', base, messages: [{ id: 'counter-turn:0', role: 'assistant', content: 'Feedback' }], lessonKB: { lessonId, startedAt: 1, ...(path.includes('lessonKB:') ? body.data : { status: 'active' }) } };
    turn.receipt = signCoachTurn(turn);
    return authedReq(app, 'POST', `/v1/sync/lesson-turn/${lessonId}`, turn);
  }
  let incCalls;
  let setCalls;
  beforeEach(() => {
    incCalls = [];
    setCalls = [];
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
    db.putSyncData = async () => ({ version: 1, updatedAt: new Date().toISOString() });
    db.incrementUserCounter = async (userId, field, delta) => { incCalls.push({ userId, field, delta }); };
    db.setUserActivityField = async (userId, field, value) => { setCalls.push({ userId, field, value }); };
  });

  it('first transition to status=completed on a PUBLIC lesson increments lessonsCompleted', async () => {
    db.getSyncData = async (uid, key) => {
      if (uid === '_system' && key === 'lesson:l1') return { data: { status: 'public', markdown: '#' } };
      return { data: { status: 'in_progress' }, version: 1 }; // lessonKB pre-read
    };
    const app = new Hono();
    app.route('/', sync);
    const res = await commitFixture(app, 'PUT', '/v1/sync/lessonKB:l1', { data: { status: 'completed' }, version: 1 });
    assert.equal(res.status, 200);
    assert.equal(incCalls.length, 1);
    assert.deepEqual(incCalls[0], { userId: 'usr_test', field: 'lessonsCompleted', delta: 1 });
  });

  it('completing a private/draft/custom lesson does NOT increment lessonsCompleted', async () => {
    // Private lesson: present in _system but not public.
    db.getSyncData = async (uid, key) => {
      if (uid === '_system' && key === 'lesson:l1') return { data: { status: 'private', markdown: '#' } };
      return { data: { status: 'in_progress' }, version: 1 };
    };
    const app = new Hono();
    app.route('/', sync);
    const res = await commitFixture(app, 'PUT', '/v1/sync/lessonKB:l1', { data: { status: 'completed' }, version: 1 });
    assert.equal(res.status, 200);
    assert.equal(incCalls.length, 0, 'private lesson completion is not counted');

    // Custom lesson: no _system:lesson record at all.
    db.getSyncData = async (uid) => (uid === '_system' ? null : { data: { status: 'in_progress' }, version: 1 });
    const res2 = await commitFixture(app, 'PUT', '/v1/sync/lessonKB:custom-abc', { data: { status: 'completed' }, version: 1 });
    assert.equal(res2.status, 200);
    assert.equal(incCalls.length, 0, 'custom lesson completion is not counted');
  });

  it('repeat write with same status=completed does NOT double-count', async () => {
    db.getSyncData = async () => ({ data: { status: 'completed' }, version: 2 });
    const app = new Hono();
    app.route('/', sync);
    const res = await commitFixture(app, 'PUT', '/v1/sync/lessonKB:l1', { data: { status: 'completed', extraFeedback: true }, version: 2 });
    assert.equal(res.status, 200);
    assert.equal(incCalls.length, 0, 'no counter bump when status was already completed');
  });

  it('messages:* writes do NOT touch lastActiveAt (write-amplification anti-goal)', async () => {
    db.getSyncData = async () => null;
    const app = new Hono();
    app.route('/', sync);
    const res = await commitFixture(app, 'PUT', '/v1/sync/messages:l1', { data: [{ role: 'user', content: 'hi' }], version: 0 });
    assert.equal(res.status, 200);
    assert.equal(setCalls.length, 0, 'lastActiveAt belongs on the auth route, not the message hot path');
  });

  it('non-lessonKB writes do not touch counters', async () => {
    db.getSyncData = async () => null;
    const app = new Hono();
    app.route('/', sync);
    const res = await commitFixture(app, 'PUT', '/v1/sync/preferences', { data: { theme: 'dark' }, version: 0 });
    assert.equal(res.status, 200);
    assert.equal(incCalls.length, 0);
    assert.equal(setCalls.length, 0);
  });

  it('counter write failures do not break the sync write', async () => {
    db.getSyncData = async (uid, key) => {
      if (uid === '_system' && key === 'lesson:l1') return { data: { status: 'public', markdown: '#' } };
      return { data: { status: 'in_progress' }, version: 1 };
    };
    db.incrementUserCounter = async () => { throw new Error('db hiccup'); };
    const app = new Hono();
    app.route('/', sync);
    const res = await commitFixture(app, 'PUT', '/v1/sync/lessonKB:l1', { data: { status: 'completed' }, version: 1 });
    assert.equal(res.status, 200, 'sync write succeeds even if counter update throws');
  });

  it('unavailable canonical criteria retain the turn instead of accepting an unverifiable assessment', async () => {
    // Simulates DynamoDB throttling on the getSyncData call that detects the
    // status transition. The primary write must still succeed; the counter
    // just won't bump (lazy backfill heals it later).
    db.getSyncData = async () => { throw new Error('throttled'); };
    const app = new Hono();
    app.route('/', sync);
    const res = await commitFixture(app, 'PUT', '/v1/sync/lessonKB:l1', { data: { status: 'completed' }, version: 0 });
    assert.equal(res.status, 500, 'canonical criteria must be readable before committing new assessment');
  });
});

describe('POST /v1/sync/lesson-started', () => {
  beforeEach(() => {
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
    db.getSyncData = async (_uid, key) => key.startsWith('lesson:') ? { data: { status: 'public', markdown: '# Test\n## Exemplar\nLearn WordPress\n## Learning Objectives\n- Understand hooks' } } : null;
  });

  it('returns empty enrichments when no plugins are enabled', async () => {
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'POST', '/v1/sync/lesson-started', {
      lessonId: 'test-lesson',
      lesson: { name: 'Test', markdown: '# Test', exemplar: 'Learn WordPress', learningObjectives: ['Understand hooks'] },
      lessonKB: { status: 'active' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.enrichments), 'enrichments must be an array');
    assert.ok(Array.isArray(data.startupSteps), 'startupSteps must be an array');
  });

  it('requires lessonId, lesson, and lessonKB', async () => {
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'POST', '/v1/sync/lesson-started', {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error, 'must return error when required fields missing');
  });

  it('rejects writes when viewing as another user', async () => {
    db.getUserById = async () => ({ userId: 'usr_admin', role: 'admin' });
    const app = new Hono();
    app.route('/', sync);
    const token = await signAccessToken('usr_admin', 'admin');
    const res = await app.request('/v1/sync/lesson-started?asUserId=usr_other', {
      method: 'POST',
      headers: { ...currentClientHeaders, 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        lessonId: 'test',
        lesson: { name: 'T', markdown: '# T', exemplar: 'E', learningObjectives: [] },
        lessonKB: {},
      }),
    });
    assert.equal(res.status, 403, 'must reject write when asUserId is present');
  });

  it('accepts optional coachDirective field', async () => {
    const app = new Hono();
    app.route('/', sync);
    const res = await authedReq(app, 'POST', '/v1/sync/lesson-started', {
      lessonId: 'test-lesson',
      lesson: {
        name: 'Test',
        markdown: '# Test',
        exemplar: 'Learn WordPress',
        learningObjectives: ['Understand hooks'],
        coachDirective: 'Point learners to the Block Editor Handbook',
      },
      lessonKB: { status: 'active' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.enrichments), 'enrichments must be an array');
  });
});
