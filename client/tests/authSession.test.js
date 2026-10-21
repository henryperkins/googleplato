import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

function browserStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), clear: () => values.clear() };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const session = id => ({ accessToken: `access-${id}`, refreshToken: `refresh-${id}`, provider: 'password', user: { userId: id } });
globalThis.localStorage = browserStorage();
globalThis.sessionStorage = browserStorage();
globalThis.window = {};
globalThis.indexedDB = { databases: async () => [] };
const storage = await import('../js/storage.js');
const auth = await import('../js/auth.js');

beforeEach(async () => {
  await storage.clearAuth();
  sessionStorage.clear();
  localStorage.setItem('plato_auth', JSON.stringify(session('a')));
  globalThis.indexedDB.databases = async () => [];
  globalThis.fetch = async () => json({ ok: true });
});

test('logout snapshots and clears the old credentials before yielding to another login', async () => {
  const logout = auth.logout();
  assert.equal(localStorage.getItem('plato_auth'), null);
  await storage.saveAuthTokens(session('b'));
  await storage.saveAuthUser(session('b').user);
  storage.saveAuthProvider('password');
  await logout;
  assert.deepEqual(await storage.getAuthTokens(), session('b'));
});

test('logout ends local access and resolves while remote revocation is still stalled', async () => {
  const remote = deferred();
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return remote.promise; };
  sessionStorage.setItem('plato_compose_draft:a:lesson-1', 'Owned draft');
  sessionStorage.setItem('plato_generated_turn:a:lesson-1', 'Generated reply');
  let finished = false;
  const logout = auth.logout().then(() => { finished = true; });
  await nextTurn();
  try {
    assert.equal(await storage.getAuthTokens(), null);
    assert.equal(finished, true);
    assert.equal(request.url, '/v1/auth/logout');
    assert.equal(JSON.parse(request.options.body).refreshToken, 'refresh-a');
    assert.equal(sessionStorage.getItem('plato_compose_draft:a:lesson-1'), 'Owned draft');
    assert.equal(sessionStorage.getItem('plato_generated_turn:a:lesson-1'), 'Generated reply');
  } finally {
    remote.resolve(json({ ok: true }));
    await logout;
  }
});

test('late logout completion cannot clear a newer signed-in session', async () => {
  const remote = deferred();
  globalThis.fetch = async url => url === '/v1/auth/logout' ? remote.promise : json(session('b'));
  const logout = auth.logout();
  await nextTurn();
  await auth.login('b@example.test', 'test-password');
  remote.resolve(json({ ok: true }));
  await logout;
  await nextTurn();
  assert.deepEqual(await storage.getAuthTokens(), session('b'));
});

test('remote revocation is aborted after five seconds without delaying local logout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = deferred();
  let signal;
  globalThis.fetch = async (url, options) => { signal = options.signal; return remote.promise; };
  const logout = auth.logout();
  await nextTurn();
  try {
    assert.ok(signal, 'remote revocation needs a bounded AbortSignal');
    t.mock.timers.tick(5000);
    await nextTurn();
    assert.equal(signal.aborted, true);
    assert.equal(await storage.getAuthTokens(), null);
  } finally {
    remote.resolve(json({ ok: true }));
    await logout;
    t.mock.timers.reset();
  }
});

test('a refresh that completes after logout cannot restore local credentials', async () => {
  const refresh = deferred();
  const started = deferred();
  globalThis.fetch = async url => {
    if (url === '/v1/auth/refresh') { started.resolve(); return refresh.promise; }
    return url === '/v1/auth/logout' ? json({ ok: true }) : json({}, 401);
  };
  const request = auth.authenticatedFetch('/v1/me').catch(() => null);
  await started.promise;
  await auth.logout();
  refresh.resolve(json(session('refreshed-a')));
  await request;
  assert.equal(await storage.getAuthTokens(), null);
});

test('logout between the refresh identity snapshot and token write still wins', async () => {
  const refresh = deferred();
  const started = deferred();
  globalThis.fetch = async url => {
    if (url === '/v1/auth/refresh') { started.resolve(); return refresh.promise; }
    return { ok: url === '/v1/auth/logout', status: url === '/v1/auth/logout' ? 200 : 401 };
  };
  const request = auth.authenticatedFetch('/v1/me').catch(() => null);
  await started.promise;
  refresh.resolve({ ok: true, json: async () => session('refreshed-a') });
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  await auth.logout();
  await request;
  assert.equal(await storage.getAuthTokens(), null);
});

test('an old refresh cannot overwrite a newer account or retry a request as that account', async () => {
  const refresh = deferred();
  const started = deferred();
  let protectedRequests = 0;
  globalThis.fetch = async url => {
    if (url === '/v1/auth/refresh') { started.resolve(); return refresh.promise; }
    if (url === '/v1/auth/login') return json(session('b'));
    protectedRequests += 1;
    return json({}, 401);
  };
  const request = auth.authenticatedFetch('/v1/me').catch(() => null);
  await started.promise;
  await auth.login('b@example.test', 'test-password');
  refresh.resolve(json(session('refreshed-a')));
  await request;
  assert.deepEqual(await storage.getAuthTokens(), session('b'));
  assert.equal(protectedRequests, 1);
});

test('a stale refresh rejection does not expire the newer session', async () => {
  const refresh = deferred();
  const started = deferred();
  let expired = 0;
  const unsubscribe = auth.onSessionExpired(() => { expired += 1; });
  globalThis.fetch = async url => {
    if (url === '/v1/auth/refresh') { started.resolve(); return refresh.promise; }
    return url === '/v1/auth/login' ? json(session('b')) : json({}, 401);
  };
  try {
    const request = auth.authenticatedFetch('/v1/me').catch(() => null);
    await started.promise;
    await auth.login('b@example.test', 'test-password');
    refresh.resolve(json({}, 401));
    await request;
    assert.equal(expired, 0);
    assert.deepEqual(await storage.getAuthTokens(), session('b'));
  } finally { unsubscribe(); }
});

test('legacy Firebase detection cannot block logout or erase the next account', async () => {
  const probe = deferred();
  const old = session('a');
  delete old.provider;
  localStorage.setItem('plato_auth', JSON.stringify(old));
  globalThis.indexedDB.databases = () => probe.promise;
  globalThis.fetch = async url => url === '/v1/auth/login' ? json(session('b')) : json({ ok: true });
  const logout = auth.logout();
  await nextTurn();
  try {
    assert.equal(await storage.getAuthTokens(), null);
    await auth.login('b@example.test', 'test-password');
  } finally {
    probe.resolve([]);
    await logout;
  }
  assert.deepEqual(await storage.getAuthTokens(), session('b'));
});
