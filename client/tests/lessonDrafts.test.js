import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLessonDraftStore } from '../src/lib/lessonDrafts.js';

function fixture() {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  return { storage, drafts: createLessonDraftStore({ storage: () => storage }) };
}

test('a reload restores the exact text only for its account and lesson', () => {
  const { storage, drafts } = fixture();
  const text = 'Reflection\n日本語, العربية and an emoji 🌱';
  drafts.write('learner-a', 'lesson-1', text);
  const reloaded = createLessonDraftStore({ storage: () => storage });
  assert.equal(reloaded.read('learner-a', 'lesson-1'), text);
  assert.equal(reloaded.read('learner-b', 'lesson-1'), '');
  assert.equal(reloaded.read('learner-a', 'lesson-2'), '');
});

test('switching back restores each account’s own draft without changing either', () => {
  const { drafts } = fixture();
  drafts.write('learner-a', 'lesson-1', 'A’s reflection');
  drafts.write('learner-b', 'lesson-1', 'B’s reflection');
  assert.equal(drafts.read('learner-a', 'lesson-1'), 'A’s reflection');
  assert.equal(drafts.read('learner-b', 'lesson-1'), 'B’s reflection');
});

test('sending or clearing one draft preserves other drafts and generated-turn recovery', () => {
  const { storage, drafts } = fixture();
  storage.setItem('plato_generated_turn:learner-a:lesson-1', 'retained reply');
  drafts.write('learner-a', 'lesson-1', 'Send this');
  drafts.write('learner-a', 'lesson-2', 'Keep this');
  drafts.write('learner-b', 'lesson-1', 'Keep B’s');
  drafts.write('learner-a', 'lesson-1', '');
  assert.equal(drafts.read('learner-a', 'lesson-1'), '');
  assert.equal(drafts.read('learner-a', 'lesson-2'), 'Keep this');
  assert.equal(drafts.read('learner-b', 'lesson-1'), 'Keep B’s');
  assert.equal(storage.getItem('plato_generated_turn:learner-a:lesson-1'), 'retained reply');
});

test('unowned legacy drafts are retained without being attributed to either account', () => {
  const { storage, drafts } = fixture();
  storage.setItem('plato_compose_draft:lesson-1', 'Unknown owner');
  assert.equal(drafts.read('learner-a', 'lesson-1'), '');
  assert.equal(drafts.read('learner-b', 'lesson-1'), '');
  drafts.write('learner-a', 'lesson-1', 'New owned draft');
  assert.equal(storage.getItem('plato_compose_draft:lesson-1'), 'Unknown owner');
});

test('absent owners and lesson IDs cannot read or write a draft', () => {
  const { drafts } = fixture();
  for (const [userId, lessonId] of [[null, 'lesson-1'], ['learner-a', null], ['', 'lesson-1']]) {
    drafts.write(userId, lessonId, 'Must not be shared');
    assert.equal(drafts.read(userId, lessonId), '');
  }
});

test('owner and lesson delimiters cannot collide', () => {
  const { drafts } = fixture();
  drafts.write('a:b', 'c', 'First owner');
  drafts.write('a', 'b:c', 'Second owner');
  assert.equal(drafts.read('a:b', 'c'), 'First owner');
  assert.equal(drafts.read('a', 'b:c'), 'Second owner');
});

test('unavailable session storage preserves the current in-memory editing path', () => {
  const drafts = createLessonDraftStore({ storage: () => { throw new Error('Storage blocked'); } });
  assert.equal(drafts.read('learner-a', 'lesson-1'), '');
  assert.doesNotThrow(() => drafts.write('learner-a', 'lesson-1', 'Still editable in React state'));
});
