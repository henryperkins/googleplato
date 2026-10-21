import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('a compatible Google session cannot hydrate writable state from the Firestore mirror', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    globalThis.window = {};
    globalThis.localStorage = { getItem: () => JSON.stringify({ accessToken: 'token', provider: 'firebase', user: { userId: 'google' } }) };
    globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('/status')
      ? { protocol: '1', epoch: 'first' }
      : [{ dataKey: 'lessons:live', data: { lessonId: 'live' }, version: 1 }]));
    const { loadAll } = await import('./js/sync.js');
    const { getUserLessons, _populateCache } = await import('./js/storage.js');
    _populateCache('lessons:deleted', { lessonId: 'deleted' }, 50);
    await loadAll();
    assert.deepEqual((await getUserLessons()).map(lesson => lesson.lessonId), ['live']);
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
