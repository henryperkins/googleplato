import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../../../src/lib/db.js';
import { getUserMeta, putUserMeta, updateUserMeta, deleteUserMeta } from '../../../src/lib/plugins/sdk.js';

function fakeUserSyncStore() {
  const store = new Map();
  const k = (userId, key) => `${userId}\0${key}`;
  return {
    getSyncData: async (u, key) => store.get(k(u, key)) || null,
    putSyncData: async (u, key, data, expectedVersion) => {
      const cur = store.get(k(u, key));
      const ver = cur?.version || 0;
      if (expectedVersion !== ver) {
        const err = new Error('conflict'); err.name = 'ConditionalCheckFailedException'; throw err;
      }
      const next = { data, version: ver + 1 };
      store.set(k(u, key), next);
      return next;
    },
    deleteSyncData: async (u, key) => { store.delete(k(u, key)); },
    _peek: () => store,
  };
}

describe('plugin SDK — user metadata', () => {
  let store;
  beforeEach(() => {
    store = fakeUserSyncStore();
    db.getSyncData = store.getSyncData;
    db.putSyncData = store.putSyncData;
    db.deleteSyncData = store.deleteSyncData;
  });

  it('getUserMeta returns null when no record exists', async () => {
    const out = await getUserMeta('usr_x', 'demo');
    assert.equal(out, null);
  });

  it('putUserMeta then getUserMeta round-trips', async () => {
    await putUserMeta('usr_x', 'demo', { foo: 'bar' });
    const out = await getUserMeta('usr_x', 'demo');
    assert.deepEqual(out, { foo: 'bar' });
  });

  it('storage key is exactly userMeta:<pluginId>', async () => {
    await putUserMeta('usr_x', 'teacher-comments', { text: 'hi' });
    const raw = await store.getSyncData('usr_x', 'userMeta:teacher-comments');
    assert.deepEqual(raw.data, { text: 'hi' });
  });

  it('plugins are isolated from each other', async () => {
    await putUserMeta('usr_x', 'pluginA', { a: 1 });
    await putUserMeta('usr_x', 'pluginB', { b: 2 });
    assert.deepEqual(await getUserMeta('usr_x', 'pluginA'), { a: 1 });
    assert.deepEqual(await getUserMeta('usr_x', 'pluginB'), { b: 2 });
  });

  it('users are isolated within the same plugin', async () => {
    await putUserMeta('usr_x', 'demo', { value: 'X' });
    await putUserMeta('usr_y', 'demo', { value: 'Y' });
    assert.deepEqual(await getUserMeta('usr_x', 'demo'), { value: 'X' });
    assert.deepEqual(await getUserMeta('usr_y', 'demo'), { value: 'Y' });
  });

  it('putUserMeta updates an existing record', async () => {
    await putUserMeta('usr_x', 'demo', { count: 1 });
    await putUserMeta('usr_x', 'demo', { count: 2 });
    assert.deepEqual(await getUserMeta('usr_x', 'demo'), { count: 2 });
  });

  it('deleteUserMeta removes the record', async () => {
    await putUserMeta('usr_x', 'demo', { foo: 'bar' });
    await deleteUserMeta('usr_x', 'demo');
    assert.equal(await getUserMeta('usr_x', 'demo'), null);
  });

  it('rejects missing userId or pluginId', async () => {
    await assert.rejects(() => getUserMeta('', 'demo'), /required/);
    await assert.rejects(() => getUserMeta('usr_x', ''), /required/);
    await assert.rejects(() => putUserMeta('usr_x', 'demo', null), /must be an object/);
    await assert.rejects(() => putUserMeta('usr_x', 'demo', 'string'), /must be an object/);
    await assert.rejects(() => deleteUserMeta('', 'demo'), /required/);
  });

  it('updateUserMeta uses one consistent read and a strict conditional write', async () => {
    await putUserMeta('usr_x', 'demo', { count: 1 });
    const read = db.getSyncData;
    const write = db.putSyncData;
    let reads = 0;
    let writeArgs;
    db.getSyncData = async (...args) => {
      reads++;
      assert.deepEqual(args[2], { consistentRead: true });
      return read(...args);
    };
    db.putSyncData = async (...args) => {
      writeArgs = args;
      return write(...args);
    };

    await updateUserMeta('usr_x', 'demo', (meta) => ({ count: meta.count + 1 }));

    assert.equal(reads, 1);
    assert.equal(writeArgs[3], 1);
    assert.deepEqual(writeArgs[4], { strictVersion: true });
    const raw = await store.getSyncData('usr_x', 'userMeta:demo');
    assert.deepEqual(raw.data, { count: 2 });
  });

  it('updateUserMeta validates its updater and returned object', async () => {
    await assert.rejects(() => updateUserMeta('usr_x', 'demo', null), /updater must be a function/);
    await assert.rejects(() => updateUserMeta('usr_x', 'demo', () => null), /updater must return an object/);
    await assert.rejects(() => updateUserMeta('usr_x', 'demo', () => []), /updater must return an object/);
    await assert.rejects(() => updateUserMeta('usr_x', 'demo', () => 'string'), /updater must return an object/);
  });

  it('updateUserMeta propagates a conflict when two updates read the same snapshot', async () => {
    await putUserMeta('usr_x', 'demo', { count: 1 });
    const read = db.getSyncData;
    let reads = 0;
    let releaseReads;
    const bothRead = new Promise((resolve) => { releaseReads = resolve; });
    db.getSyncData = async (...args) => {
      const snapshot = await read(...args);
      reads++;
      if (reads === 2) releaseReads();
      await bothRead;
      return snapshot;
    };

    const results = await Promise.allSettled([
      updateUserMeta('usr_x', 'demo', (meta) => ({ ...meta, writer: 'a' })),
      updateUserMeta('usr_x', 'demo', (meta) => ({ ...meta, writer: 'b' })),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.name, 'ConditionalCheckFailedException');
    const raw = await store.getSyncData('usr_x', 'userMeta:demo');
    assert.equal(raw.version, 2);
    assert.ok(['a', 'b'].includes(raw.data.writer));
  });
});
