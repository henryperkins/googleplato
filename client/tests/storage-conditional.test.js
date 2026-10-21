import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearCache, _populateCache, putSyncData, getLearnerProfile, getScreenshot, deleteScreenshot } from '../js/storage.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  const userId = crypto.randomUUID();
  globalThis.localStorage = { getItem: () => JSON.stringify({ user: { userId }, accessToken: 'test' }) };
  clearCache();
});

test('telemetry owner lookup cannot move a save into the next account', async () => {
  let tokens = { accessToken: 'access-a', user: { userId: 'account-a' } };
  globalThis.localStorage = { getItem: () => JSON.stringify(tokens) };
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/status')) return json({ protocol: '1', epoch: 'test' });
    if (options.method === 'PUT') writes.push(options);
    return json({ version: 1 });
  };
  const saving = putSyncData('profile', { name: 'Account A private draft' });
  tokens = { accessToken: 'access-b', user: { userId: 'account-b' } };
  assert.equal(await saving, false);
  assert.equal(writes.length, 0);
});

test('failure telemetry never waits for an unfinished rejected-save body', async () => {
  let stream;
  globalThis.fetch = async url => {
    if (url.endsWith('/status')) return json({ protocol: '1', epoch: 'test' });
    return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode('{"error":')); } }), { status: 503 });
  };
  const saving = putSyncData('profile', { name: 'Retain this draft' });
  let outcome;
  try {
    outcome = await Promise.race([saving, new Promise(resolve => setTimeout(() => resolve('stalled'), 50))]);
  } finally { stream?.close(); }
  await saving;
  assert.equal(outcome, false);
});

test('an invalid save acknowledgement cannot be reported as recovered', async () => {
  globalThis.fetch = async url => url.endsWith('/status') ? json({ protocol: '1', epoch: 'test' }) : json({});
  assert.equal(await putSyncData('profile', { name: 'Learner' }), false);
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
