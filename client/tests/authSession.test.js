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

test('normal admin requests tolerate a denied session storage getter', async () => {
  const original = globalThis.sessionStorage;
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return json({ ok: true }); };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new DOMException('Blocked', 'SecurityError'); } });
  try {
    assert.doesNotThrow(() => auth.getImpersonation());
    assert.equal(auth.getImpersonation(), null);
    const response = await auth.authenticatedFetch('/v1/admin/ai-settings');
    assert.equal(response.status, 200);
    assert.equal(request.url, '/v1/admin/ai-settings');
    assert.equal(new Headers(request.options.headers).get('Authorization'), 'Bearer access-a');
  } finally {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: original });
  }
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
  sessionStorage.setItem('plato_compose_draft_v2:a:lesson-1', 'Owned draft');
  sessionStorage.setItem('plato_generated_turn:a:lesson-1', 'Generated reply');
  let finished = false;
  const logout = auth.logout().then(() => { finished = true; });
  await nextTurn();
  try {
    assert.equal(await storage.getAuthTokens(), null);
    assert.equal(finished, true);
    assert.equal(request.url, '/v1/auth/logout');
    assert.equal(JSON.parse(request.options.body).refreshToken, 'refresh-a');
    assert.equal(sessionStorage.getItem('plato_compose_draft_v2:a:lesson-1'), 'Owned draft');
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

test('a late 401 reuses a sibling request’s refreshed token in the same session', async () => {
  const lateResponse = deferred();
  const lateStarted = deferred();
  const lateHeaders = [];
  let refreshCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (url === '/v1/auth/refresh') {
      refreshCalls += 1;
      return json({ accessToken: 'refreshed-access-a', refreshToken: 'refreshed-refresh-a' });
    }
    const token = new Headers(options.headers).get('Authorization');
    if (url === '/late') {
      lateHeaders.push(token);
      if (token === 'Bearer access-a') {
        lateStarted.resolve();
        return lateResponse.promise;
      }
    }
    return json({}, token === 'Bearer access-a' ? 401 : 200);
  };
  const first = auth.authenticatedFetch('/first');
  const late = auth.authenticatedFetch('/late');
  await lateStarted.promise;
  assert.equal((await first).status, 200);
  lateResponse.resolve(json({}, 401));
  assert.equal((await late).status, 200);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(lateHeaders, ['Bearer access-a', 'Bearer refreshed-access-a']);
  assert.equal((await storage.getAuthTokens()).user.userId, 'a');
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

test('a pending response cannot cross logout and re-login even as the same account', async () => {
  const response = deferred();
  const started = deferred();
  globalThis.fetch = async url => {
    if (url === '/v1/auth/login') return json(session('a'));
    if (url === '/v1/auth/logout') return json({ ok: true });
    started.resolve();
    return response.promise;
  };
  const request = auth.authenticatedFetch('/v1/me');
  const rejected = assert.rejects(request, /account changed|Session expired/);
  await started.promise;
  await auth.logout();
  await auth.login('a@example.test', 'test-password');
  response.resolve(json({ name: 'Stale profile' }));
  await rejected;
  assert.deepEqual(await storage.getAuthTokens(), session('a'));
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

test('a password change keeps this device signed in with the pair the server issued', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/v1/me');
    assert.equal(options.method, 'PATCH');
    return json({ userId: 'a', name: 'A', session: { accessToken: 'access-a2', refreshToken: 'refresh-a2' } });
  };
  assert.deepEqual(await auth.updateProfile({ password: 'new-password' }), { userId: 'a', name: 'A' });
  assert.deepEqual(await storage.getAuthTokens(), {
    ...session('a'), accessToken: 'access-a2', refreshToken: 'refresh-a2', user: { userId: 'a', name: 'A' },
  });
});

test('a password-change response that crosses logout cannot restore credentials', async () => {
  const body = deferred();
  const parsing = deferred();
  globalThis.fetch = async url => url === '/v1/me'
    ? { ok: true, status: 200, json: () => { parsing.resolve(); return body.promise; } }
    : json({ ok: true });
  const pending = auth.updateProfile({ password: 'new-password' });
  const rejected = assert.rejects(pending, /account changed/);
  await parsing.promise;
  await auth.logout();
  body.resolve({ userId: 'a', session: { accessToken: 'access-a2', refreshToken: 'refresh-a2' } });
  await rejected;
  assert.equal(await storage.getAuthTokens(), null);
});

test('an owner-bound Settings request cannot submit old draft values under another account', async () => {
  localStorage.setItem('plato_auth', JSON.stringify(session('b')));
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ userId: 'b' }); };
  await assert.rejects(auth.updateProfile({ customFields: { goal: 'A private draft' } }, 'a'), /account changed/);
  await assert.rejects(auth.getMyFields('a'), /account changed/);
  assert.equal(calls, 0);
  assert.deepEqual(await storage.getAuthTokens(), session('b'));
});

test('a delayed Settings response body cannot replace the next account profile', async () => {
  const body = deferred();
  const parsing = deferred();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: () => { parsing.resolve(); return body.promise; } });
  const pending = auth.updateProfile({ customFields: { goal: 'A draft' } }, 'a');
  const rejected = assert.rejects(pending, /account changed/);
  await parsing.promise;
  localStorage.setItem('plato_auth', JSON.stringify(session('b')));
  body.resolve({ userId: 'a', customFields: { goal: 'A draft' } });
  await rejected;
  assert.deepEqual(await storage.getAuthTokens(), session('b'));
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

test('compatibility checks support cancellation and deadlines without newer AbortSignal helpers', async t => {
  const originalAny = AbortSignal.any;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.any = undefined;
  AbortSignal.timeout = undefined;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let statusSignal;
  let refreshSignal;
  let writes = 0;
  let completeStatus = false;
  let needsRefresh = false;
  globalThis.fetch = async (url, options) => {
    if (url === '/v1/sync/status' || url === '/v1/auth/refresh') {
      if (url === '/v1/sync/status') {
        statusSignal = options.signal;
        if (completeStatus) return json({ protocol: '1', epoch: 'test' });
        if (needsRefresh) return json({}, 401);
      } else refreshSignal = options.signal;
      const signal = options.signal;
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(signal.reason);
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    }
    writes++;
    assert.equal(new Headers(options.headers).get('X-Plato-Client-Epoch'), 'test');
    return json({ ok: true });
  };
  try {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(auth.authenticatedFetch('/v1/sync/profile', { method: 'PUT', signal: alreadyAborted.signal }), { name: 'AbortError' });

    const caller = new AbortController();
    const cancelled = assert.rejects(auth.authenticatedFetch('/v1/sync/profile', { method: 'PUT', signal: caller.signal }), { name: 'AbortError' });
    await nextTurn();
    caller.abort();
    await cancelled;
    assert.equal(writes, 0);

    const timedOut = assert.rejects(auth.authenticatedFetch('/v1/sync/profile', { method: 'PUT' }), { name: 'TimeoutError' });
    await nextTurn();
    t.mock.timers.tick(10_000);
    await timedOut;
    assert.equal(writes, 0);

    needsRefresh = true;
    for (const cancel of ['caller', 'deadline']) {
      const controller = new AbortController();
      let settled = false;
      const result = auth.authenticatedFetch('/v1/sync/profile', { method: 'PUT', signal: controller.signal })
        .then(response => { settled = true; return response; }, error => { settled = true; return error; });
      await nextTurn();
      if (cancel === 'caller') controller.abort();
      else t.mock.timers.tick(10_000);
      await nextTurn();
      assert.equal(settled, true, `${cancel} cancellation must also end a stalled token refresh`);
      assert.equal((await result).name, cancel === 'caller' ? 'AbortError' : 'TimeoutError');
      assert.equal(refreshSignal.aborted, true);
      assert.equal(writes, 0);
    }

    completeStatus = true;
    const successfulCaller = new AbortController();
    const response = await auth.authenticatedFetch('/v1/sync/profile', { method: 'PUT', signal: successfulCaller.signal });
    assert.equal(response.status, 200);
    assert.equal(writes, 1);
    successfulCaller.abort();
    t.mock.timers.tick(10_000);
    assert.equal(statusSignal.aborted, false, 'completed handshake removes its listener and timer');
  } finally {
    AbortSignal.any = originalAny;
    AbortSignal.timeout = originalTimeout;
    t.mock.timers.reset();
  }
});
