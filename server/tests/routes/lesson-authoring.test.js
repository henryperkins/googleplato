import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import admin from '../../src/routes/admin.js';
import db from '../../src/lib/db.js';
import { signAccessToken } from '../../src/lib/jwt.js';

const markdown = '# Test\n\n## Exemplar\nDo it\n\n## Learning Objectives\n- Can do A\n- Can do B';
let record;
let writes;
let app;
beforeEach(() => {
  record = { data: { status: 'draft', name: 'Untitled draft', markdown: '' }, version: 1 };
  writes = 0;
  db.getUserById = async () => ({ userId: 'admin', role: 'admin' });
  db.getSyncData = async () => record;
  db.putSyncData = async (_uid, _key, data, version) => {
    writes++;
    assert.equal(version, record?.version || 0);
    record = { data, version: version + 1 };
    return { version: record.version };
  };
  app = new Hono();
  app.route('/', admin);
});
async function request(method, body, suffix = '') {
  return app.request(`/v1/admin/lessons/test${suffix}`, {
    method,
    headers: { Authorization: `Bearer ${await signAccessToken('admin', 'admin')}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('loads the version needed to protect an authoring session', async () => {
  assert.equal((await (await request('GET')).json()).version, 1);
});

test('conversation and course autosaves preserve a built-in lesson', async () => {
  record.data = { status: 'public', markdown, name: 'Built-in lesson', isBuiltIn: true, sharedWith: ['learner'] };
  const res = await request('PUT', { expectedVersion: 1, course: 'communication', conversation: [] });
  assert.equal(res.status, 200);
  assert.equal(record.data.isBuiltIn, true);
  assert.equal(record.data.status, 'public');
  assert.deepEqual(record.data.sharedWith, ['learner']);
  assert.equal(record.data.markdown, markdown);
});

test('rejects a delayed draft save after finalization without changing the lesson', async () => {
  await request('PUT', { markdown, name: 'Reviewed lesson', status: 'private' });
  const res = await request('PUT', { status: 'draft', name: 'Untitled draft', conversation: [] });
  assert.equal(res.status, 409);
  assert.equal(record.data.name, 'Reviewed lesson');
  assert.equal(writes, 1);
});

test('publishes reviewed draft content and visibility together and acknowledges the same retry', async () => {
  const body = { expectedVersion: 1, operationId: 'publish-reviewed', markdown,
    name: 'Reviewed lesson', status: 'public', sharedWith: ['author'] };
  assert.equal((await request('PUT', body)).status, 200);
  assert.equal(record.data.status, 'public');
  assert.equal(record.data.markdown, markdown);
  assert.deepEqual(record.data.sharedWith, ['author']);
  assert.equal(record.version, 2);
  assert.equal((await request('PUT', body)).status, 200);
  assert.equal(writes, 1);
});

test('rejects invalid publishing without changing draft content or visibility', async () => {
  const res = await request('PUT', { expectedVersion: 1, operationId: 'invalid-publish',
    markdown: '# Incomplete lesson', status: 'public' });
  assert.equal(res.status, 400);
  assert.equal(record.data.status, 'draft');
  assert.equal(record.data.markdown, '');
  assert.equal(writes, 0);
});

test('rejects stale versions for content and conversation writes', async () => {
  for (const suffix of ['', '/conversation']) {
    const res = await request('PUT', { expectedVersion: 0, conversation: [] }, suffix);
    assert.equal(res.status, 409);
  }
  assert.equal(writes, 0);
});

test('retries a committed operation without writing it twice after a lost response', async () => {
  const body = { expectedVersion: 1, operationId: 'save-1', conversation: [{ role: 'user', content: 'hello' }] };
  const first = await request('PUT', body);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).version, 2);
  const retry = await request('PUT', body);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).version, 2);
  assert.equal(writes, 1);
});

test('rejects malformed share lists even when an operation was already committed', async () => {
  const body = { expectedVersion: 1, operationId: 'save-shares', markdown, status: 'private', sharedWith: ['learner'] };
  assert.equal((await request('PUT', body)).status, 200);
  const saved = structuredClone(record);
  for (const sharedWith of [null, {}, 42, true, '', ['learner', 42]]) {
    const res = await request('PUT', { ...body, sharedWith });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /sharedWith must be an array/);
  }
  assert.equal(writes, 1);
  assert.deepEqual(record, saved);
  assert.equal((await request('PUT', body)).status, 200);
  assert.equal(writes, 1);
});

test('a course deletion invalidates an earlier lost-response retry', async () => {
  record.data.course = 'communication';
  const body = { expectedVersion: 1, operationId: 'save-before-delete', course: 'communication', conversation: [] };
  assert.equal((await request('PUT', body)).status, 200);
  db.getAllSyncData = async () => [{ ...record, dataKey: 'lesson:test' }];
  db.deleteSyncData = async (userId, dataKey) => {
    assert.equal(userId, '_system');
    assert.equal(dataKey, 'course:communication');
  };
  const deleted = await app.request('/v1/admin/courses/communication', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${await signAccessToken('admin', 'admin')}` },
  });
  assert.equal(deleted.status, 200);
  assert.equal(record.data.course, null);
  assert.equal((await request('PUT', body)).status, 409);
  const saved = await (await request('GET')).json();
  assert.equal(saved.version, 3);
  assert.notEqual(saved.authoringOperationId, body.operationId);
  assert.equal(writes, 2);
});

test('a competing database write returns a recoverable conflict', async () => {
  db.putSyncData = async () => { throw Object.assign(new Error('Version mismatch'), { name: 'ConditionalCheckFailedException' }); };
  const res = await request('PUT', { expectedVersion: 1, conversation: [] });
  assert.equal(res.status, 409);
});

test('concurrent retries of the same operation acknowledge one committed write', async () => {
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  let reads = 0;
  db.getSyncData = async () => {
    const current = record;
    if (++reads <= 2) {
      if (reads === 2) release();
      await bothRead;
    }
    return current;
  };
  db.putSyncData = async (_uid, _key, data, version) => {
    if (record.version !== version) throw Object.assign(new Error('Conflict'), { name: 'ConditionalCheckFailedException' });
    writes++;
    record = { data, version: version + 1 };
    return { version: record.version };
  };
  const body = { expectedVersion: 1, operationId: 'same-save', conversation: [] };
  const responses = await Promise.all([request('PUT', body), request('PUT', body)]);
  assert.deepEqual(responses.map(res => res.status), [200, 200]);
  assert.equal(writes, 1);
});

test('rejects invalid revision metadata before writing', async () => {
  for (const body of [{ expectedVersion: -1 }, { expectedVersion: '1' }, { operationId: {} }]) {
    assert.equal((await request('PUT', body)).status, 400);
  }
  assert.equal(writes, 0);
});
