import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLessonSubmissionStore, submissionWasSaved, hasLessonDraft } from '../src/lib/lessonSubmissions.js';
import { createLessonDraftStore } from '../src/lib/lessonDrafts.js';

function disk() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const text = '  A response\n日本語 🌱  ';
const image = { name: 'original.png', dataUrl: 'data:image/png;base64,AA==' };
const link = { url: 'https://example.test', title: 'Reference', text: 'Full extracted context', siteName: 'Example' };
const cases = [
  { text, images: [], links: [] },
  { text: '', images: [image], links: [] },
  { text: '', images: [], links: [link] },
  { text: '', images: [image], links: [link] },
];

for (const [index, draft] of cases.entries()) {
  test(`submitted payload ${index} survives navigation/reload independently of newer input`, () => {
    const storage = disk();
    const submissions = createLessonSubmissionStore({ storage: () => storage });
    const drafts = createLessonDraftStore({ storage: () => storage });
    const entry = submissions.stage('learner:a', 'lesson:1', draft);
    drafts.write('learner:a', 'lesson:1', { text: 'A newer draft', images: [image], links: [link] });
    submissions.setStatus(entry, 'failed');
    const reloaded = createLessonSubmissionStore({ storage: () => storage });
    assert.deepEqual(reloaded.read('learner:a', 'lesson:1').draft, draft);
    assert.equal(reloaded.read('learner:a', 'lesson:1').status, 'interrupted');
    assert.equal(drafts.read('learner:a', 'lesson:1').text, 'A newer draft');
    assert.equal(reloaded.read('learner', 'a:lesson:1'), null);
    assert.equal(reloaded.read('b', 'lesson:1'), null);
  });
}

test('blocked and silently ignored storage retain the composer and cannot start a submission', () => {
  for (const storage of [{ setItem() {}, getItem: () => null }, { setItem() { throw new Error('Quota'); }, getItem: () => null }]) {
    const store = createLessonSubmissionStore({ storage: () => storage });
    assert.throws(() => store.stage('a', 'lesson', cases[3]), /could not be kept/);
    assert.equal(store.read('a', 'lesson'), null);
  }
});

test('a second send cannot replace a pending response; old completions cannot clear a later one', () => {
  const storage = disk();
  const store = createLessonSubmissionStore({ storage: () => storage });
  const first = store.stage('a', 'lesson', cases[0]);
  assert.throws(() => store.stage('a', 'lesson', cases[1]), /earlier response/);
  assert.equal(store.clear(first), true);
  const second = store.stage('a', 'lesson', cases[1]);
  store.clear(first);
  store.setStatus(first, 'failed');
  assert.equal(store.read('a', 'lesson').id, second.id);
});

test('only the exact committed learner and coach IDs settle interrupted input', () => {
  const entry = { id: 'same-turn' };
  assert.equal(submissionWasSaved(entry, { messages: { data: [{ id: 'same-turn:0', role: 'user' }] } }), false);
  assert.equal(submissionWasSaved(entry, { messages: { data: [{ id: 'other:0', role: 'user' }, { id: 'other:1', role: 'assistant' }] } }), false);
  assert.equal(submissionWasSaved(entry, { messages: { data: [{ id: 'same-turn:0', role: 'user' }, { id: 'same-turn:1', role: 'assistant' }] } }), true);
});

test('unowned or corrupt persisted submissions never become recovery input', () => {
  const storage = disk();
  for (const value of ['invalid json', JSON.stringify({ id: 'x', userId: 'b', lessonId: 'lesson', draft: cases[0] }), JSON.stringify({ id: 'x', userId: 'a', lessonId: 'lesson', draft: { text } })]) {
    storage.setItem('plato_lesson_submission:a:lesson', value);
    assert.equal(createLessonSubmissionStore({ storage: () => storage }).read('a', 'lesson'), null);
  }
});

test('restore availability treats whitespace, images and links as existing draft content', () => {
  for (const draft of [...cases, { text: ' ', images: [], links: [] }]) assert.equal(hasLessonDraft(draft), true);
  assert.equal(hasLessonDraft({ text: '', images: [], links: [] }), false);
});

test('reload preflight verifies every retained submission, including another account', () => {
  const storage = disk();
  const store = createLessonSubmissionStore({ storage: () => storage });
  store.stage('a', 'lesson', cases[0]);
  store.stage('b', 'lesson', cases[1]);
  storage.setItem = () => { throw new Error('Quota'); };
  assert.equal(store.preserveAllForReload(), false);
});
