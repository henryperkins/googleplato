import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cachedLessonStatuses, loadLessonStatuses } from '../src/lib/lessonListProgress.js';
import { clearCache, _populateCache, getCachedLessonKB } from '../js/storage.js';

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
const lessons = [{ lessonId: 'started' }, { lessonId: 'new' }];
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const record = (lessonId, data) => ({ dataKey: `lessonKB:${lessonId}`, data, version: data ? 1 : 0 });

beforeEach(() => {
  clearCache();
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ accessToken: 'test-token', provider: 'password', user: { userId: 'progress-test' } }),
  };
});
afterEach(() => {
  clearCache();
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalStorage;
});

describe('cached lesson status snapshots', () => {
  it('keeps a cache miss unknown unless a complete bulk sync was confirmed', () => {
    _populateCache('lessonKB:started', { status: 'learning', progress: 0 }, 1);
    assert.equal(cachedLessonStatuses(lessons), null);
    assert.deepEqual(cachedLessonStatuses(lessons, { complete: true }), {
      started: { status: 'learning', progress: 0 }, new: { status: null, progress: null },
    });
  });

  it('accepts an explicit null record as verified not-started progress', () => {
    _populateCache('lessonKB:started', { status: 'completed', progress: 10 }, 1);
    _populateCache('lessonKB:new', null, 0);
    assert.deepEqual(cachedLessonStatuses(lessons), {
      started: { status: 'completed', progress: 10 }, new: { status: null, progress: null },
    });
    assert.deepEqual(cachedLessonStatuses([]), {});
  });
});

describe('fallback lesson status snapshots', () => {
  it('reads current records and confirmed absence without writing the shared cache', async () => {
    const reads = [];
    _populateCache('lessonKB:started', { status: 'learning', progress: 2 }, 1);
    globalThis.fetch = async url => {
      if (url.endsWith('/status')) return response({ protocol: '1', epoch: 'test' });
      reads.push(url);
      return response(url.endsWith('started') ? record('started', { status: 'completed', progress: 10 }) : record('new', null));
    };
    assert.deepEqual(await loadLessonStatuses(lessons), {
      started: { status: 'completed', progress: 10 }, new: { status: null, progress: null },
    });
    assert.equal(reads.length, 2);
    assert.deepEqual(getCachedLessonKB('started'), { status: 'learning', progress: 2 });
    assert.equal(getCachedLessonKB('new'), undefined);
  });

  it('rejects a failed read instead of marking that lesson not started', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(loadLessonStatuses(lessons), /could not be loaded/);
  });

  it('rejects network errors instead of returning a partial status map', async () => {
    globalThis.fetch = async url => {
      if (url.endsWith('started')) return response(record('started', { status: 'learning' }));
      throw new Error('Offline');
    };
    await assert.rejects(loadLessonStatuses(lessons), /Offline/);
  });

  it('rejects missing, mismatched, or malformed records', async () => {
    for (const item of [null, {}, { dataKey: 'lessonKB:started' }, record('wrong', null), record('started', []), record('started', 'invalid')]) {
      globalThis.fetch = async () => response(item);
      await assert.rejects(loadLessonStatuses(lessons), /incomplete/);
    }
  });

  it('does not start reads for a cancelled catalog', async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async () => { assert.fail('No read after cancellation'); };
    await assert.rejects(loadLessonStatuses(lessons, { signal: controller.signal }), { name: 'AbortError' });
  });

  it('ignores a superseded response body without reading the next lesson or replacing fresh cache data', async () => {
    let finishBody;
    let bodyStarted;
    const reached = new Promise(resolve => { bodyStarted = resolve; });
    const controller = new AbortController();
    let reads = 0;
    globalThis.fetch = async () => {
      reads++;
      return { ok: true, status: 200, json: () => {
        bodyStarted();
        return new Promise(resolve => { finishBody = resolve; });
      } };
    };
    const pending = loadLessonStatuses(lessons, { signal: controller.signal });
    await reached;
    controller.abort();
    _populateCache('lessonKB:started', { status: 'completed', progress: 10 }, 2);
    finishBody(record('started', { status: 'learning', progress: 1 }));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(reads, 1);
    assert.deepEqual(getCachedLessonKB('started'), { status: 'completed', progress: 10 });
  });
});
