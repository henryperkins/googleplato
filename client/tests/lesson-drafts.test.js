import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLessonDraftStore } from '../src/lib/lessonDrafts.js';

function disk() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const draft = { text: 'A private thought', images: [{ name: 'work.png', dataUrl: 'data:image/png;base64,AA==' }], links: [{ url: 'https://example.test', text: 'Reference context' }] };

test('a fresh page restores text and attachments only for the same account and lesson', () => {
  const storage = disk();
  const page = createLessonDraftStore({ storage: () => storage });
  assert.equal(page.write('a', 'lesson', draft), true);
  const nextPage = createLessonDraftStore({ storage: () => storage });
  assert.deepEqual(nextPage.read('a', 'lesson'), draft);
  assert.deepEqual(nextPage.read('b', 'lesson'), { text: '', images: [], links: [] });
  assert.deepEqual(nextPage.read('a', 'other'), { text: '', images: [], links: [] });
});

test('blocked or silently discarded browser writes cannot authorize a reload', () => {
  for (const storage of [{ setItem() {}, getItem: () => null }, { setItem() { throw new Error('Quota'); } }]) {
    const page = createLessonDraftStore({ storage: () => storage });
    assert.equal(page.write('a', 'lesson', draft), false);
    assert.deepEqual(page.read('a', 'lesson'), draft);
  }
});

test('legacy unscoped text never leaks into another account and is left intact', () => {
  const storage = disk();
  storage.setItem('plato_compose_draft:lesson', 'Unknown previous learner');
  const page = createLessonDraftStore({ storage: () => storage });
  assert.deepEqual(page.read('new-learner', 'lesson'), { text: '', images: [], links: [] });
  assert.equal(storage.getItem('plato_compose_draft:lesson'), 'Unknown previous learner');
});

test('reload verifies drafts from every visited lesson and account', () => {
  const storage = disk();
  const page = createLessonDraftStore({ storage: () => storage });
  page.write('previous-account', 'other-lesson', draft);
  const write = storage.setItem;
  storage.setItem = (key, value) => { if (key.includes('previous-account')) throw new Error('Quota'); write(key, value); };
  page.write('current-account', 'lesson', { text: 'Current draft', images: [], links: [] });
  assert.equal(page.preserveAllForReload(), false);
  storage.setItem = write;
  assert.equal(page.preserveAllForReload(), true);
  assert.deepEqual(createLessonDraftStore({ storage: () => storage }).read('previous-account', 'other-lesson'), draft);
});

test('an existing account-scoped text draft upgrades without losing its owner or content', () => {
  const storage = disk();
  const oldKey = 'plato_compose_draft_v2:learner%3Aa:lesson%3A1';
  storage.setItem(oldKey, 'Existing reflection\n日本語 🌱');
  const page = createLessonDraftStore({ storage: () => storage });
  const restored = page.read('learner:a', 'lesson:1');
  assert.deepEqual(restored, { text: 'Existing reflection\n日本語 🌱', images: [], links: [] });
  assert.equal(page.read('another-learner', 'lesson:1').text, '');
  assert.equal(page.write('learner:a', 'lesson:1', restored), true);
  assert.equal(storage.getItem(oldKey), null, 'remove old copy only after verified storage of the new format');
  assert.deepEqual(createLessonDraftStore({ storage: () => storage }).read('learner:a', 'lesson:1'), restored);
});

test('failed draft-format migration keeps the account-scoped text copy recoverable', () => {
  const storage = disk();
  const oldKey = 'plato_compose_draft_v2:learner:lesson';
  storage.setItem(oldKey, 'Still recoverable');
  storage.setItem = () => { throw new Error('Quota'); };
  const page = createLessonDraftStore({ storage: () => storage });
  assert.equal(page.write('learner', 'lesson', page.read('learner', 'lesson')), false);
  assert.equal(storage.getItem(oldKey), 'Still recoverable');
  assert.equal(createLessonDraftStore({ storage: () => storage }).read('learner', 'lesson').text, 'Still recoverable');
});

test('an explicitly emptied rich draft does not revive an older text draft', () => {
  const storage = disk();
  const page = createLessonDraftStore({ storage: () => storage });
  page.write('learner', 'lesson', { text: '', images: [], links: [] });
  storage.setItem('plato_compose_draft_v2:learner:lesson', 'Stale text from an older page');
  assert.equal(createLessonDraftStore({ storage: () => storage }).read('learner', 'lesson').text, '');
});
