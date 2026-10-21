import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('a compatible Google session cannot hydrate writable state from the Firestore mirror', () => {
  // Mock the external SDK boundary in a fresh page/module graph. Both backfill
  // and a later subscription delivery attempt to restore deleted work.
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    let mirrorReads = 0;
    mock.module('./js/firebaseClient.js', { namedExports: {
      loadAllSyncDataFromFirestore: async () => { mirrorReads++; return [{ dataKey: 'lessons:deleted', data: { lessonId: 'deleted' }, version: 50 }]; },
      subscribeToFirestoreSync: callback => { mirrorReads++; callback('lessons:live', { lessonId: 'stale' }, 50); return () => {}; },
    } });
    globalThis.window = {};
    globalThis.localStorage = { getItem: () => JSON.stringify({ accessToken: 'token', provider: 'firebase', user: { userId: 'google' } }) };
    globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('/status')
      ? { protocol: '1', epoch: 'first' }
      : [{ dataKey: 'lessons:live', data: { lessonId: 'live' }, version: 1 }]));
    const { loadAll } = await import('./js/sync.js');
    const { getUserLessons } = await import('./js/storage.js');
    await loadAll();
    assert.deepEqual((await getUserLessons()).map(lesson => lesson.lessonId), ['live']);
    assert.equal(mirrorReads, 0);
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
