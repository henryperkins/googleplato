import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLessonDraftStore } from '../src/lib/lessonDrafts.js';

function disk() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
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
