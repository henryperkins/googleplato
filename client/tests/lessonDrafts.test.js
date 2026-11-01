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
  drafts.write('learner-a', 'lesson-1', { text: text, images: [], links: [] });
  const reloaded = createLessonDraftStore({ storage: () => storage });
  assert.equal(reloaded.read('learner-a', 'lesson-1').text, text);
  assert.equal(reloaded.read('learner-b', 'lesson-1').text, '');
  assert.equal(reloaded.read('learner-a', 'lesson-2').text, '');
});

test('switching back restores each account’s own draft without changing either', () => {
  const { drafts } = fixture();
  drafts.write('learner-a', 'lesson-1', { text: 'A’s reflection', images: [], links: [] });
  drafts.write('learner-b', 'lesson-1', { text: 'B’s reflection', images: [], links: [] });
  assert.equal(drafts.read('learner-a', 'lesson-1').text, 'A’s reflection');
  assert.equal(drafts.read('learner-b', 'lesson-1').text, 'B’s reflection');
});

test('sending or clearing one draft preserves other drafts and generated-turn recovery', () => {
  const { storage, drafts } = fixture();
  storage.setItem('plato_generated_turn:learner-a:lesson-1', 'retained reply');
  drafts.write('learner-a', 'lesson-1', { text: 'Send this', images: [], links: [] });
  drafts.write('learner-a', 'lesson-2', { text: 'Keep this', images: [], links: [] });
  drafts.write('learner-b', 'lesson-1', { text: 'Keep B’s', images: [], links: [] });
  drafts.write('learner-a', 'lesson-1', { text: '', images: [], links: [] });
  assert.equal(drafts.read('learner-a', 'lesson-1').text, '');
  assert.equal(drafts.read('learner-a', 'lesson-2').text, 'Keep this');
  assert.equal(drafts.read('learner-b', 'lesson-1').text, 'Keep B’s');
  assert.equal(storage.getItem('plato_generated_turn:learner-a:lesson-1'), 'retained reply');
});

test('unowned legacy drafts are retained without being attributed to either account', () => {
  const { storage, drafts } = fixture();
  storage.setItem('plato_compose_draft:lesson-1', 'Unknown owner');
  assert.equal(drafts.read('learner-a', 'lesson-1').text, '');
  assert.equal(drafts.read('learner-b', 'lesson-1').text, '');
  drafts.write('learner-a', 'lesson-1', { text: 'New owned draft', images: [], links: [] });
  assert.equal(storage.getItem('plato_compose_draft:lesson-1'), 'Unknown owner');
});

test('a legacy lesson ID cannot collide with an account-owned draft key', () => {
  const { storage, drafts } = fixture();
  const legacyKey = 'plato_compose_draft:u_known-user:lesson-1';
  storage.setItem(legacyKey, 'Private text from the legacy lesson u_known-user:lesson-1');
  assert.equal(drafts.read('u_known-user', 'lesson-1').text, '');
  drafts.write('u_known-user', 'lesson-1', { text: 'New owned reflection', images: [], links: [] });
  assert.equal(drafts.read('u_known-user', 'lesson-1').text, 'New owned reflection');
  assert.equal(storage.getItem(legacyKey), 'Private text from the legacy lesson u_known-user:lesson-1');
});

test('absent owners and lesson IDs cannot read or write a draft', () => {
  const { drafts } = fixture();
  for (const [userId, lessonId] of [[null, 'lesson-1'], ['learner-a', null], ['', 'lesson-1']]) {
    drafts.write(userId, lessonId, { text: 'Must not be shared', images: [], links: [] });
    assert.equal(drafts.read(userId, lessonId).text, '');
  }
});

test('owner and lesson delimiters cannot collide', () => {
  const { drafts } = fixture();
  drafts.write('a:b', 'c', { text: 'First owner', images: [], links: [] });
  drafts.write('a', 'b:c', { text: 'Second owner', images: [], links: [] });
  assert.equal(drafts.read('a:b', 'c').text, 'First owner');
  assert.equal(drafts.read('a', 'b:c').text, 'Second owner');
});

test('unavailable session storage preserves the current in-memory editing path', () => {
  const drafts = createLessonDraftStore({ storage: () => { throw new Error('Storage blocked'); } });
  assert.equal(drafts.read('learner-a', 'lesson-1').text, '');
  assert.doesNotThrow(() => drafts.write('learner-a', 'lesson-1', { text: 'Still editable in React state', images: [], links: [] }));
});

test('failed readback retains the exact latest draft in memory until a verified retry', () => {
  const { storage, drafts } = fixture();
  const observed = [];
  const unsubscribe = drafts.subscribe(() => observed.push(drafts.retentionStatus('a', 'lesson')));
  const earlier = { text: 'Earlier draft', images: [], links: [] };
  const latest = { text: '  Latest 日本語 🌱\nSecond line  ', images: [{ name: 'work.png', dataUrl: 'data:image/png;base64,synthetic' }], links: [{ url: 'https://example.test', title: 'Reference', text: 'Context' }] };
  assert.equal(drafts.write('a', 'lesson', earlier), true);
  const setItem = storage.setItem;
  storage.setItem = () => {};
  assert.equal(drafts.write('a', 'lesson', latest), false);
  assert.deepEqual(drafts.read('a', 'lesson'), latest);
  assert.deepEqual(createLessonDraftStore({ storage: () => storage }).read('a', 'lesson'), earlier);
  storage.setItem = setItem;
  assert.equal(drafts.write('a', 'lesson', latest), true);
  assert.deepEqual(observed, ['retained', 'failed', 'retained']);
  assert.equal(drafts.retentionStatus('b', 'lesson'), 'pending');
  assert.equal(drafts.retentionStatus(null, 'lesson'), 'unavailable');
  unsubscribe();
  assert.deepEqual(createLessonDraftStore({ storage: () => storage }).read('a', 'lesson'), latest);
  assert.equal(drafts.read('b', 'lesson').text, '');
});
