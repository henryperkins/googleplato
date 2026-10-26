import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const session = id => ({ accessToken: `access-${id}`, refreshToken: `refresh-${id}`, user: { userId: id } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const storage = await import('../js/storage.js');

beforeEach(() => {
  storage.clearCache();
  localStorage.setItem('plato_auth', JSON.stringify(session('a')));
});

test('a rejected owner-bound profile save does not replace acknowledged cached data', async () => {
  storage._populateCache('profile', { goal: 'Saved goal' }, 1);
  globalThis.fetch = async url => url === '/v1/sync/status' ? json({ protocol: '1', epoch: 'test' }) : json({}, 503);
  await assert.rejects(storage.saveLearnerProfile({ goal: 'Unsaved change' }, { expectedUserId: 'a' }), /could not be confirmed/);
  assert.deepEqual(await storage.getLearnerProfile(), { goal: 'Saved goal' });
});

test('a late profile-save acknowledgement cannot populate the next account cache', async () => {
  const body = deferred(), parsing = deferred();
  storage._populateCache('profile', { goal: 'A original' }, 1);
  globalThis.fetch = async url => url === '/v1/sync/status' ? json({ protocol: '1', epoch: 'test' })
    : { ok: true, status: 200, json: () => { parsing.resolve(); return body.promise; } };
  const pending = storage.saveLearnerProfile({ goal: 'A update' }, { expectedUserId: 'a' });
  const rejected = assert.rejects(pending, /could not be confirmed/);
  await parsing.promise;
  localStorage.setItem('plato_auth', JSON.stringify(session('b')));
  storage.clearCache();
  storage._populateCache('profile', { goal: 'B original' }, 2);
  body.resolve({ version: 2 });
  await rejected;
  assert.deepEqual(await storage.getLearnerProfile(), { goal: 'B original' });
});
