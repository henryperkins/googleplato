import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from '../js/sync.js';
import { clearCache, _populateCache, getUserLessons } from '../js/storage.js';

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
const savedLesson = id => ({ dataKey: `lessons:${id}`, data: { lessonId: id, markdown: `# ${id}` }, version: 1 });
const response = items => new Response(JSON.stringify(items), { headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  clearCache();
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ accessToken: 'test-token', provider: 'password' }),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalStorage;
});

describe('sync load cancellation', () => {
  it('replaces the cached collection with the current server response', async () => {
    _populateCache('lessons:old', { lessonId: 'old' }, 1);
    globalThis.fetch = async () => response([savedLesson('current')]);
    await loadAll();
    assert.deepEqual((await getUserLessons()).map(lesson => lesson.lessonId), ['current']);
  });

  it('keeps newer cached data when a superseded server response arrives', async () => {
    let finishRequest;
    let requestStarted;
    const started = new Promise(resolve => { requestStarted = resolve; });
    let current = true;
    globalThis.fetch = () => {
      requestStarted();
      return new Promise(resolve => { finishRequest = resolve; });
    };
    const pending = loadAll({ isCurrent: () => current });
    await started;
    current = false;
    _populateCache('lessons:current', { lessonId: 'current' }, 2);
    finishRequest(response([savedLesson('stale')]));
    await pending;
    assert.deepEqual((await getUserLessons()).map(lesson => lesson.lessonId), ['current']);
  });

  it('does not repopulate a cleared session if cancellation occurs while decoding the body', async () => {
    let body;
    let responseStarted;
    const started = new Promise(resolve => { responseStarted = resolve; });
    let current = true;
    const stream = new ReadableStream({
      start(controller) {
        body = controller;
        body.enqueue(new TextEncoder().encode('['));
      },
      pull() { responseStarted(); },
    });
    globalThis.fetch = async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    const pending = loadAll({ isCurrent: () => current });
    await started;
    current = false;
    clearCache();
    body.enqueue(new TextEncoder().encode(JSON.stringify([savedLesson('previous-session')]).slice(1)));
    body.close();
    await pending;
    assert.deepEqual(await getUserLessons(), []);
  });
});
