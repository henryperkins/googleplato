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
