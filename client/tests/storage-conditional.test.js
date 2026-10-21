import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearCache, _populateCache, putSyncData, getLearnerProfile, getScreenshot, deleteScreenshot } from '../js/storage.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  const userId = crypto.randomUUID();
  globalThis.localStorage = { getItem: () => JSON.stringify({ user: { userId }, accessToken: 'test' }) };
  clearCache();
});

for (const code of ['sync_conflict', 'client_upgrade_required']) {
  test(`${code} retains the original write without fetching a new version and overwriting`, async () => {
    const writes = [];
    let reads = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (url.endsWith('/status')) return json({ protocol: '1', epoch: 'test' });
      if (options.method === 'PUT') {
        writes.push(JSON.parse(options.body));
        return writes.length === 1 ? json({ code, error: 'Rejected' }, 409) : json({ version: 6 });
      }
      reads++;
      return json({ data: { name: 'Other device' }, version: 5 });
    };
    _populateCache('profile', { name: 'Original' }, 1);
    assert.equal(await putSyncData('profile', { name: 'My edit' }), false);
    assert.equal(writes.length, 1);
    assert.equal(reads, 0);
    assert.deepEqual(writes[0], { data: { name: 'My edit' }, version: 1 });
    assert.equal((await getLearnerProfile()).name, 'My edit');
  });
}

test('a rejected delete keeps the cached saved record and surfaces the upgrade', async () => {
  _populateCache('screenshot:image', 'data:image/png;base64,AA==', 1);
  globalThis.fetch = async url => url.endsWith('/status') ? json({ protocol: '1', epoch: 'first' })
    : json({ code: 'client_upgrade_required', error: 'Update required' }, 409);
  await assert.rejects(deleteScreenshot('image'), { code: 'client_upgrade_required' });
  assert.equal(await getScreenshot('image'), 'data:image/png;base64,AA==');
});
