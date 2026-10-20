import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadLessons, invalidateLessonsCache, getLessonsInCourse } from '../js/lessonOwner.js';
import { clearCache, _populateCache } from '../js/storage.js';

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
const lesson = {
  lessonId: 'feedback',
  markdown: '# Give useful feedback\n\nPractice specific feedback.\n\n## Exemplar\nWrite useful feedback.\n\n## Learning Objectives\n- Name the behavior.',
  course: { id: 'communication', name: 'Communication' },
};
const response = data => new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  clearCache();
  invalidateLessonsCache();
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ accessToken: 'test-token', provider: 'password' }),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalStorage;
});

describe('lesson loading and recovery', () => {
  it('rejects an unavailable classroom instead of reporting an empty list', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(loadLessons());
  });

  it('rejects a network failure instead of reporting an empty list', async () => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(loadLessons());
  });

  it('can load lessons after a failed attempt without a cached empty result', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(loadLessons());
    globalThis.fetch = async () => response([lesson]);
    const lessons = await loadLessons();
    assert.equal(lessons[0].name, 'Give useful feedback');
    assert.deepEqual(lessons[0].course, { id: 'communication', name: 'Communication' });
  });

  it('accepts a genuinely empty classroom and keeps its successful cache', async () => {
    globalThis.fetch = async () => response([]);
    assert.deepEqual(await loadLessons(), []);
    globalThis.fetch = async () => { throw new Error('cached result should be used'); };
    assert.deepEqual(await loadLessons(), []);
  });

  it('rejects malformed lesson data', async () => {
    globalThis.fetch = async () => response({ error: 'not a lesson collection' });
    await assert.rejects(loadLessons());
  });

  it('merges saved custom lessons without duplicating published lessons', async () => {
    _populateCache('lessons:feedback', lesson, 1);
    _populateCache('lessons:custom-1', { lessonId: 'custom-1', markdown: '# A custom lesson\n\nPractice a skill.' }, 1);
    globalThis.fetch = async () => response([lesson]);
    assert.deepEqual((await loadLessons()).map(item => item.lessonId), ['custom-1', 'feedback']);
  });

  it('provides the course agent with the names and descriptions for its course', async () => {
    globalThis.fetch = async () => response([lesson, { ...lesson, lessonId: 'other', course: { id: 'other' } }]);
    assert.deepEqual(await getLessonsInCourse('communication'), [{ name: 'Give useful feedback', description: 'Practice specific feedback.' }]);
  });

  it('keeps optional course context available as an empty list during a catalog outage', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    assert.deepEqual(await getLessonsInCourse('communication'), []);
    await assert.rejects(loadLessons());
  });

  it('does not replace a refreshed cache with an older request that finishes later', async () => {
    let finishOld;
    let started;
    const requestStarted = new Promise(resolve => { started = resolve; });
    globalThis.fetch = () => {
      started();
      return new Promise(resolve => { finishOld = resolve; });
    };
    const oldRequest = loadLessons();
    await requestStarted;
    invalidateLessonsCache();
    globalThis.fetch = async () => response([{ ...lesson, lessonId: 'current' }]);
    await loadLessons();
    finishOld(response([{ ...lesson, lessonId: 'old' }]));
    await oldRequest;
    assert.equal((await loadLessons())[0].lessonId, 'current');
  });
});
