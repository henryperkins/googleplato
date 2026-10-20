import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLessonSaveQueue, readLessonRecovery, canStartNewDraft } from '../src/lib/lessonSaveQueue.js';

function storage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) || null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const setup = (options = {}) => createLessonSaveQueue({
  version: 1, storage: storage(), storageKey: 'user:lesson',
  snapshot: { conversation: [], previewMarkdown: '' }, ...options,
});

test('only a confirmed missing draft can start a new conversation', () => {
  const id = `admin-${Date.now()}`;
  assert.equal(canStartNewDraft(id, { status: 500 }), false);
  assert.equal(canStartNewDraft(id, { status: 403 }), false);
  assert.equal(canStartNewDraft(id, { status: 404 }), true);
  assert.equal(canStartNewDraft(`admin-${Date.now() + 60000}`, { status: 404 }), false);
});

test('finalization waits for draft saves and uses their acknowledged version', async () => {
  const gate = deferred();
  const calls = [];
  const queue = setup({ write: async body => {
    calls.push(body);
    if (calls.length === 1) await gate.promise;
    return { version: body.expectedVersion + 1 };
  } });
  queue.enqueue({ status: 'draft', conversation: ['first'] });
  const saving = queue.save({ status: 'private', markdown: 'Reviewed content' });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  gate.resolve();
  await saving;
  assert.deepEqual(calls.map(c => [c.status, c.expectedVersion]), [['draft', 1], ['private', 2]]);
});

test('lost-response retry preserves operation identity and reviewed markdown', async () => {
  const calls = [];
  const queue = setup({ write: async body => {
    calls.push(body);
    if (calls.length === 1) throw new Error('Connection lost after commit');
    return { version: 2 };
  } });
  await assert.rejects(queue.save({ markdown: 'Reviewed content' }));
  await queue.flush();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(queue.getState().pending, 0);
});

test('reload recovers submitted turns, preview and pending writes without calling AI', async () => {
  const disk = storage();
  const queue = setup({ storage: disk, write: async () => { throw new Error('Offline'); } });
  queue.remember({ conversation: ['submitted'], previewMarkdown: 'Reviewed', failedReply: true });
  await assert.rejects(queue.save({ conversation: ['submitted'] }));
  const recovery = readLessonRecovery(disk, 'user:lesson');
  let writes = 0;
  const resumed = setup({ storage: disk, recovery, write: async () => { writes++; return { version: 2 }; } });
  assert.equal(resumed.getState().snapshot.previewMarkdown, 'Reviewed');
  assert.equal(resumed.getState().snapshot.failedReply, true);
  await resumed.flush();
  assert.equal(writes, 1);
});

test('reload reconciles a committed write whose response was lost', async () => {
  const disk = storage();
  const queue = setup({ storage: disk, write: async () => { throw new Error('Disconnected'); } });
  await assert.rejects(queue.save({ conversation: ['submitted'] }));
  const recovery = readLessonRecovery(disk, 'user:lesson');
  const resumed = setup({ version: 2, operationId: recovery.operations[0].id, recovery,
    write: async () => { assert.fail('already committed'); } });
  await resumed.flush();
  assert.equal(resumed.getState().pending, 0);
  assert.equal(resumed.getState().version, 2);
});

test('stale recovery stays available but cannot overwrite newer remote work', async () => {
  const recovery = { version: 1, snapshot: { conversation: ['local'] }, operations: [] };
  const resumed = setup({ recovery, version: 3, write: async () => assert.fail('stale write') });
  await assert.rejects(resumed.flush(), { status: 409 });
  assert.deepEqual(resumed.getState().snapshot.conversation, ['local']);
});

test('storage failure is visible and does not prevent saving to the server', async () => {
  const queue = setup({ storage: { setItem() { throw new Error('Quota exceeded'); } },
    write: async () => ({ version: 2 }) });
  queue.remember({ conversation: ['submitted'] });
  assert.ok(queue.getState().localError);
  await queue.save({ conversation: ['submitted'] });
  assert.equal(queue.getState().pending, 0);
});

test('pausing a departed editor does not send its remaining queued writes', async () => {
  const gate = deferred();
  let writes = 0;
  const queue = setup({ write: async () => { writes++; await gate.promise; return { version: 2 }; } });
  queue.enqueue({ conversation: ['first'] });
  await Promise.resolve();
  queue.enqueue({ conversation: ['second'] });
  queue.pause();
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(queue.getState().pending, 1);
});

test('a departed response cannot overwrite a newer recovery copy or clear it', async () => {
  const disk = storage();
  const gate = deferred();
  const old = setup({ storage: disk, write: async () => { await gate.promise; return { version: 2 }; } });
  old.remember({ conversation: ['old'] });
  old.enqueue({ conversation: ['old'] });
  await Promise.resolve();
  old.pause();
  const active = setup({ storage: disk, version: 2, write: async () => { throw new Error('offline'); } });
  active.remember({ conversation: ['old', 'new submitted'], previewMarkdown: 'New preview' });
  await assert.rejects(active.save({ conversation: ['old', 'new submitted'] }));
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  old.clear();
  const recovered = readLessonRecovery(disk, 'user:lesson');
  assert.equal(recovered.snapshot.previewMarkdown, 'New preview');
  assert.equal(recovered.operations.length, 1);
});

test('a rejected preview can be revised, while an unknown save cannot be discarded', async () => {
  const queue = setup({ write: async () => { throw Object.assign(new Error('Invalid objectives'), { status: 400 }); } });
  await assert.rejects(queue.save({ markdown: 'Invalid' }));
  assert.equal(queue.discardRejected(), true);
  assert.equal(queue.getState().pending, 0);
  const unknown = setup({ write: async () => { throw new Error('Connection lost'); } });
  await assert.rejects(unknown.save({ markdown: 'Reviewed' }));
  assert.equal(unknown.discardRejected(), false);
  assert.equal(unknown.getState().pending, 1);
});
