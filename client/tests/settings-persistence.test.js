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

test('a valid late profile-save acknowledgement succeeds without replacing the next account cache or version', async () => {
  const body = deferred(), parsing = deferred();
  const writes = [];
  storage._populateCache('profile', { goal: 'A original' }, 1);
  globalThis.fetch = async (url, options) => {
    if (url === '/v1/sync/status') return json({ protocol: '1', epoch: 'test' });
    writes.push({ token: new Headers(options.headers).get('Authorization'), ...JSON.parse(options.body) });
    return { ok: true, status: 200, json: () => { parsing.resolve(); return body.promise; } };
  };
  const pending = storage.saveLearnerProfile({ goal: 'A update' }, { expectedUserId: 'a' });
  await parsing.promise;
  assert.deepEqual(writes[0], { token: 'Bearer access-a', data: { goal: 'A update' }, version: 1 });
  localStorage.setItem('plato_auth', JSON.stringify(session('b')));
  storage.clearCache();
  storage._populateCache('profile', { goal: 'B original' }, 7);
  body.resolve({ version: 2 });
  await assert.doesNotReject(pending, 'a valid server acknowledgement remains a successful save for account A');
  assert.equal((await storage.getAuthUser()).userId, 'b');
  assert.deepEqual(await storage.getLearnerProfile(), { goal: 'B original' });

  globalThis.fetch = async (_url, options) => {
    writes.push({ token: new Headers(options.headers).get('Authorization'), ...JSON.parse(options.body) });
    return json({ version: 8 });
  };
  await storage.saveLearnerProfile({ goal: 'B update' }, { expectedUserId: 'b' });
  assert.deepEqual(writes[1], { token: 'Bearer access-b', data: { goal: 'B update' }, version: 7 },
    'account B keeps its own acknowledged base version after account A acknowledgement');
  assert.deepEqual(await storage.getLearnerProfile(), { goal: 'B update' });
});
