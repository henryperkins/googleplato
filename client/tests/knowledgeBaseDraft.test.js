import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  conversationForStorage, knowledgeBaseEditorState, knowledgeBaseMarkdownForSave, savableKnowledgeBase, savedMessageCount,
} from '../src/lib/knowledgeBaseDraft.js';
import * as knowledgeBaseDraft from '../src/lib/knowledgeBaseDraft.js';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = rel => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

const savedKB = '# Studio — Knowledge Base & FAQ\n\n## 1. What Is Studio?\nA six-week design program.\n';
const loaded = [
  { role: 'user', content: 'Start', msgType: 'user' },
  { role: 'assistant', content: 'What should change?', msgType: 'guide' },
  { role: 'user', content: 'Cohorts meet on Fridays.', msgType: 'user' },
  { role: 'assistant', content: 'Noted.', msgType: 'guide' },
];
const turns = [
  { role: 'user', content: 'Add a rule about alt text.', msgType: 'user', timestamp: 1 },
  { role: 'assistant', content: 'Got it.', msgType: 'guide', timestamp: 2 },
];

function counter(result) {
  const extract = async () => { extract.calls++; return result; };
  extract.calls = 0;
  return extract;
}

describe('saving the knowledge base', () => {
  it('saves a current preview verbatim without another extraction', async () => {
    const reviewed = '# Studio — Knowledge Base\n\n**Q:** Alt text?  \n**A:** Always — even on 日本語 slides 🌱\n';
    const state = knowledgeBaseEditorState({
      messageCount: 6, savedMarkdown: savedKB, savedThrough: 4, previewMarkdown: reviewed, previewSyncedAt: 6,
    });
    assert.equal(state.previewCurrent, true);
    const extract = counter('# A different extraction that the admin never reviewed');
    const result = await knowledgeBaseMarkdownForSave({ previewMarkdown: reviewed, previewCurrent: state.previewCurrent, extract });
    assert.equal(extract.calls, 0);
    assert.deepEqual(result, { markdown: reviewed, extracted: false });
  });

  it('extracts once when the preview is stale or missing', async () => {
    const stale = { messageCount: 6, savedMarkdown: savedKB, savedThrough: 4, previewMarkdown: savedKB, previewSyncedAt: 4 };
    const missing = { messageCount: 3, savedThrough: 1, previewMarkdown: '' };
    assert.equal(knowledgeBaseEditorState(stale).previewStale, true);
    assert.equal(knowledgeBaseEditorState(missing).previewStale, false);
    for (const input of [stale, missing]) {
      const { previewCurrent } = knowledgeBaseEditorState(input);
      assert.equal(previewCurrent, false);
      const extract = counter('# Fresh extraction');
      const result = await knowledgeBaseMarkdownForSave({ previewMarkdown: input.previewMarkdown, previewCurrent, extract });
      assert.equal(extract.calls, 1);
      assert.deepEqual(result, { markdown: '# Fresh extraction', extracted: true });
    }
  });

  it('rejects empty or too-short output but lets the saved knowledge base be saved again', () => {
    assert.equal(savableKnowledgeBase('', ''), false);
    assert.equal(savableKnowledgeBase(undefined, ''), false);
    assert.equal(savableKnowledgeBase('I need more information.', savedKB), false);
    assert.equal(savableKnowledgeBase('# Ready', '# Ready'), true);
    assert.equal(savableKnowledgeBase(savedKB, ''), true);
  });
});

describe('saved and unsaved state', () => {
  it('reports an unchanged saved knowledge base as saved, with nothing to protect', () => {
    const savedThrough = savedMessageCount(loaded);
    const state = knowledgeBaseEditorState({
      messageCount: loaded.length, savedMarkdown: savedKB, savedThrough, previewMarkdown: savedKB, previewSyncedAt: savedThrough,
    });
    assert.deepEqual(state, { previewCurrent: true, previewStale: false, saved: true, dirty: false, leaveGuard: null });
  });

  it('treats new turns as unsaved until the knowledge base is saved', () => {
    const base = { savedMarkdown: savedKB, savedThrough: 4 };
    const afterTurns = knowledgeBaseEditorState({ ...base, messageCount: 6, previewMarkdown: savedKB, previewSyncedAt: 4 });
    assert.equal(afterTurns.dirty, true);
    assert.equal(afterTurns.saved, false);
    assert.equal(afterTurns.previewStale, true);
    assert.equal(afterTurns.leaveGuard, 'unsaved');

    const revised = `${savedKB}\nAlt text is required.`;
    const refreshed = knowledgeBaseEditorState({ ...base, messageCount: 6, previewMarkdown: revised, previewSyncedAt: 6 });
    assert.equal(refreshed.previewCurrent, true);
    assert.equal(refreshed.saved, false, 'a new preview keeps the unsaved banner');

    const unchangedByTurns = knowledgeBaseEditorState({ ...base, messageCount: 6, previewMarkdown: savedKB, previewSyncedAt: 6 });
    assert.equal(unchangedByTurns.saved, false, 'the turns are still not saved');
    assert.equal(unchangedByTurns.leaveGuard, 'unsaved');

    const afterSave = knowledgeBaseEditorState({ savedMarkdown: revised, savedThrough: 6, messageCount: 6, previewMarkdown: revised, previewSyncedAt: 6 });
    assert.equal(afterSave.saved, true);
    assert.equal(afterSave.leaveGuard, null);
  });

  it('treats a refreshed preview that differs from the saved knowledge base as unsaved', () => {
    const state = knowledgeBaseEditorState({
      messageCount: 4, savedMarkdown: savedKB, savedThrough: 4, previewMarkdown: `${savedKB}\nReworded.`, previewSyncedAt: 4,
    });
    assert.equal(state.previewCurrent, true);
    assert.equal(state.saved, false);
    assert.equal(state.dirty, true);
  });

  it('never calls a new knowledge base saved, but protects it only after the admin adds something', () => {
    const greeting = knowledgeBaseEditorState({ messageCount: 1, savedThrough: 1 });
    assert.equal(greeting.saved, false);
    assert.equal(greeting.leaveGuard, null);
    assert.equal(knowledgeBaseEditorState({ messageCount: 3, savedThrough: 1 }).leaveGuard, 'unsaved');
  });

  it('asks before leaving during a save or preview, and allows the page to move on after a save', () => {
    const clean = { messageCount: 4, savedMarkdown: savedKB, savedThrough: 4, previewMarkdown: savedKB, previewSyncedAt: 4 };
    assert.equal(knowledgeBaseEditorState({ ...clean, saving: true }).leaveGuard, 'saving');
    assert.equal(knowledgeBaseEditorState({ ...clean, messageCount: 6, saving: true }).leaveGuard, 'saving');
    assert.equal(knowledgeBaseEditorState({ ...clean, working: true }).leaveGuard, 'working');
    assert.equal(knowledgeBaseEditorState({ ...clean, messageCount: 6, working: true }).leaveGuard, 'unsaved');
    assert.equal(knowledgeBaseEditorState(clean).leaveGuard, null);
  });
});

describe('conversation drafts', () => {
  it('flags auto-saved turns after the last save, so reopening keeps them unsaved', () => {
    const messages = [...loaded, ...turns];
    const stored = conversationForStorage(messages, 4);
    assert.deepEqual(stored.slice(0, 4), loaded);
    assert.deepEqual(stored.slice(4), [
      { role: 'user', content: 'Add a rule about alt text.', msgType: 'user', unpublished: true },
      { role: 'assistant', content: 'Got it.', msgType: 'guide', unpublished: true },
    ]);
    const savedThrough = savedMessageCount(JSON.parse(JSON.stringify(stored)));
    assert.equal(savedThrough, 4);

    const reopened = knowledgeBaseEditorState({
      messageCount: stored.length, savedMarkdown: savedKB, savedThrough, previewMarkdown: savedKB, previewSyncedAt: savedThrough,
    });
    assert.equal(reopened.previewStale, true, 'Save extracts instead of saving the old knowledge base');
    assert.equal(reopened.dirty, true);
  });

  it('stores a saved conversation without flags and reads older drafts as saved', () => {
    const messages = [...loaded, ...turns];
    const published = conversationForStorage(messages);
    assert.equal(published.some(message => 'unpublished' in message), false);
    assert.equal(savedMessageCount(published), messages.length);
    assert.equal(savedMessageCount(loaded), loaded.length);
    assert.equal(savedMessageCount(null), 0);
    assert.equal(savedMessageCount([]), 0);
  });
});

describe('pending knowledge base writes', () => {
  function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  it('waits for every already-started draft before publication, regardless of completion order', async () => {
    const barrier = knowledgeBaseDraft.createKnowledgeBaseWriteBarrier();
    const first = deferred(), second = deferred();
    barrier.track(first.promise);
    barrier.track(second.promise);
    let published = false;
    const publication = barrier.wait().then(() => { published = true; });
    second.resolve();
    await second.promise;
    assert.equal(published, false);
    first.resolve();
    await publication;
    assert.equal(published, true);
  });

  it('includes drafts started while the publication is waiting', async () => {
    const barrier = knowledgeBaseDraft.createKnowledgeBaseWriteBarrier();
    const first = deferred(), later = deferred();
    barrier.track(first.promise);
    let published = false;
    const publication = barrier.wait().then(() => { published = true; });
    first.resolve();
    barrier.track(later.promise);
    await first.promise;
    assert.equal(published, false);
    later.resolve();
    await publication;
    assert.equal(published, true);
  });

  it('lets an explicit full save proceed after a draft fails, while still reporting that failure', async () => {
    const barrier = knowledgeBaseDraft.createKnowledgeBaseWriteBarrier();
    const failure = new Error('Draft request failed');
    const failed = deferred(), other = deferred();
    const draft = barrier.track(failed.promise);
    barrier.track(other.promise);
    let published = false;
    const publication = barrier.wait().then(() => { published = true; });
    failed.reject(failure);
    await assert.rejects(draft, error => error === failure);
    assert.equal(published, false, 'a failed request must not skip another pending draft');
    other.resolve();
    await publication;
    assert.equal(published, true);
    assert.equal(await barrier.track(Promise.resolve('next draft')), 'next draft');
    await barrier.wait();
  });

  it('rejects when a tracked draft does not settle before the deadline', async () => {
    const barrier = knowledgeBaseDraft.createKnowledgeBaseWriteBarrier();
    const stalled = deferred();
    barrier.track(stalled.promise);
    await assert.rejects(barrier.wait(20), { message: 'A draft is still saving. Try again.' });
    stalled.resolve();
    await barrier.wait(20);
  });
});

describe('editor wiring', () => {
  const editor = read('pages/admin/KnowledgeBaseEditor.jsx');
  const customizer = read('pages/admin/AdminCustomizer.jsx');
  const setup = read('pages/admin/AdminKBSetup.jsx');

  it('saves through the shared rules and clears the leave guard before the page moves on', () => {
    const save = editor.slice(editor.indexOf('async function handleSaveKB'), editor.indexOf('async function handleRefreshPreview'));
    assert.match(save, /knowledgeBaseMarkdownForSave\(/);
    assert.equal(save.match(/extractKBMarkdown\(/g)?.length, 1);
    assert.match(save, /extract: \(\) => extractKBMarkdown\(/);
    const put = save.indexOf("adminApi('PUT', '/v1/admin/knowledge-base',");
    const cleared = save.indexOf('leaveGuardRef.current = null');
    const moveOn = save.indexOf('await onSave(');
    assert.ok(put > 0 && put < cleared && cleared < moveOn);
  });

  it('protects unsaved work with the same dialog as Styles and labels saved previews', () => {
    assert.match(editor, /useBlocker\(/);
    assert.match(editor, /addEventListener\('beforeunload'/);
    assert.match(editor, /Leave without saving\?/);
    assert.match(editor, />Stay here</);
    assert.match(editor, /disabled=\{editor\.leaveGuard === 'saving'\}/);
    assert.match(editor, /<MarkdownPreviewPane[\s\S]*?saved=\{editor\.saved\}/);
  });

  it('leaves saving to the editor in both pages and keeps saving available for older knowledge bases', () => {
    for (const page of [customizer, setup]) {
      assert.equal(/'PUT', '\/v1\/admin\/knowledge-base'/.test(page), false, 'the page must not save the knowledge base a second time');
    }
    assert.match(customizer, /initialReadiness=\{kb\.readiness \?\? \(kb\.content \? 8 : 0\)\}/);
  });
});
