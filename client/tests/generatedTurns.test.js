import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeneratedTurnStore } from '../src/lib/generatedTurns.js';

const turn = { userId: 'learner-a', lessonId: 'lesson-1', turnId: 'turn-1',
  base: { messages: { data: [], version: 0 }, lessonKB: { data: null, version: 0 } },
  messages: [{ id: 'turn-1:0', role: 'assistant', content: 'Keep this reply.' }], lessonKB: { progress: 4 } };
function disk() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('a fresh page restores the exact generated output, isolated by account and lesson', () => {
  const storage = disk();
  const firstPage = createGeneratedTurnStore({ storage: () => storage });
  assert.equal(firstPage.stage(turn).persistedLocally, true);
  const reloaded = createGeneratedTurnStore({ storage: () => storage });
  assert.deepEqual(reloaded.read('learner-a', 'lesson-1').turn, turn);
  assert.equal(reloaded.read('learner-b', 'lesson-1'), null);
  assert.equal(reloaded.read('learner-a', 'lesson-2'), null);
});

test('full or unavailable browser storage retains the reply in memory and reports the limitation', () => {
  const store = createGeneratedTurnStore({ storage: () => { throw new Error('Quota exceeded'); } });
  assert.equal(store.stage(turn).persistedLocally, false);
  assert.equal(store.read('learner-a', 'lesson-1').turn.messages[0].content, 'Keep this reply.');
});

test('silently discarded writes never claim a generated reply survives reload', () => {
  const storage = { setItem() {}, getItem: () => null };
  const store = createGeneratedTurnStore({ storage: () => storage });
  assert.equal(store.stage(turn).persistedLocally, false);
  assert.deepEqual(store.read(turn.userId, turn.lessonId).turn, turn);
  assert.equal(createGeneratedTurnStore({ storage: () => storage }).read(turn.userId, turn.lessonId), null);
});

test('an acknowledgement for an older turn cannot remove a newer recovery copy', () => {
  const storage = disk();
  const store = createGeneratedTurnStore({ storage: () => storage });
  store.stage(turn);
  store.stage({ ...turn, turnId: 'turn-2' });
  store.clear('learner-a', 'lesson-1', 'turn-1');
  assert.equal(store.read('learner-a', 'lesson-1').turn.turnId, 'turn-2');
  store.clear('learner-a', 'lesson-1', 'turn-2');
  assert.equal(createGeneratedTurnStore({ storage: () => storage }).read('learner-a', 'lesson-1'), null);
});

test('explicit dismissal survives reload and only suppresses that account, lesson and turn', () => {
  const storage = disk();
  const store = createGeneratedTurnStore({ storage: () => storage });
  store.stage(turn);
  assert.equal(store.dismiss(turn.userId, turn.lessonId, turn.turnId), true);
  const reloaded = createGeneratedTurnStore({ storage: () => storage });
  assert.equal(reloaded.read(turn.userId, turn.lessonId), null);
  assert.equal(reloaded.wasDismissed(turn.userId, turn.lessonId, turn.turnId), true);
  assert.equal(reloaded.wasDismissed('other', turn.lessonId, turn.turnId), false);
  assert.equal(reloaded.wasDismissed(turn.userId, 'other', turn.turnId), false);
  assert.equal(reloaded.wasDismissed(turn.userId, turn.lessonId, 'new-turn'), false);
  reloaded.stage({ ...turn, turnId: 'new-turn' });
  assert.equal(reloaded.dismiss(turn.userId, turn.lessonId, turn.turnId), false);
  assert.equal(reloaded.read(turn.userId, turn.lessonId).turn.turnId, 'new-turn');
});

test('dismissal refuses to lose the reply when the tombstone cannot be verified', () => {
  const storage = disk();
  const store = createGeneratedTurnStore({ storage: () => storage });
  store.stage(turn);
  storage.setItem = () => {};
  assert.equal(store.dismiss(turn.userId, turn.lessonId, turn.turnId), false);
  assert.deepEqual(store.read(turn.userId, turn.lessonId).turn, turn);
});

test('reload requires a readable recovery copy even if storage was cleared after staging', () => {
  const storage = disk();
  const store = createGeneratedTurnStore({ storage: () => storage });
  const entry = store.stage(turn);
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  storage.getItem = () => null;
  assert.equal(typeof store.preserveForReload, 'function');
  assert.equal(store.preserveForReload(turn.userId, turn.lessonId), false);
  assert.equal(entry.persistedLocally, false);
  assert.deepEqual(store.read(turn.userId, turn.lessonId).turn, turn);
});

test('reload re-persists an in-memory reply when browser storage becomes available', () => {
  let storage;
  const store = createGeneratedTurnStore({ storage: () => storage });
  assert.equal(store.stage(turn).persistedLocally, false);
  storage = disk();
  assert.equal(typeof store.preserveForReload, 'function');
  assert.equal(store.preserveForReload(turn.userId, turn.lessonId), true);
  assert.deepEqual(createGeneratedTurnStore({ storage: () => storage }).read(turn.userId, turn.lessonId).turn, turn);
});

test('reload verifies every retained reply, including other lessons and accounts', () => {
  const storage = disk();
  const store = createGeneratedTurnStore({ storage: () => storage });
  const other = { ...turn, userId: 'previous-account', lessonId: 'other-lesson', turnId: 'other-turn' };
  store.stage(turn);
  store.stage(other);
  const write = storage.setItem;
  storage.setItem = (key, value) => { if (key.includes('previous-account')) throw new Error('Quota'); write(key, value); };
  assert.equal(store.preserveAllForReload(), false);
  storage.setItem = write;
  assert.equal(store.preserveAllForReload(), true);
  assert.deepEqual(createGeneratedTurnStore({ storage: () => storage }).read(other.userId, other.lessonId).turn, other);
});
