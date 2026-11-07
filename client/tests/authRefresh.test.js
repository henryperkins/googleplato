// Two requests receive 401 at once. Without refresh coordination, the server's
// atomic consume accepts one refresh token and the other request signs out first.
import { test } from 'node:test';
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
globalThis.localStorage = browserStorage();
globalThis.sessionStorage = browserStorage();
globalThis.window = {};
const auth = await import('../js/auth.js');

test('overlapping requests share a refresh instead of expiring a valid session', async () => {
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access-a', refreshToken: 'refresh-a', provider: 'password', user: { userId: 'a' } }));
  let expiredEvents = 0;
  const unsubscribe = auth.onSessionExpired(() => { expiredEvents += 1; });
  const winner = deferred();
  const refreshStarted = deferred();
  let refreshCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (url === '/v1/auth/refresh') {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        refreshStarted.resolve();
        return winner.promise;
      }
      return json({ error: 'Invalid refresh token' }, 401);
    }
    const token = new Headers(options.headers).get('Authorization');
    return json({}, token === 'Bearer access-a' ? 401 : 200);
  };
  try {
    const first = auth.authenticatedFetch('/v1/me');
    const second = auth.authenticatedFetch('/v1/sync').then(response => response.status, error => `rejected: ${error.message}`);
    await refreshStarted.promise;
    await nextTurn();
    winner.resolve(json({ accessToken: 'access-b', refreshToken: 'refresh-b' }));
    const [firstResponse, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResult, 200, 'the second request failed');
    assert.equal(refreshCalls, 1, 'parallel requests consumed the same refresh token twice');
    assert.equal(expiredEvents, 0, 'session-expired fired although the session is fine');
  } finally {
    winner.resolve(json({ accessToken: 'access-b', refreshToken: 'refresh-b' }));
    unsubscribe();
  }
});

test('a refresh waiting for the browser lock reuses another tab’s rotation', { skip: !globalThis.navigator?.locks }, async () => {
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access-a', refreshToken: 'refresh-a', provider: 'password', user: { userId: 'a' } }));
  const held = deferred();
  const release = deferred();
  const lock = navigator.locks.request('plato:auth-refresh', async () => {
    held.resolve();
    await release.promise;
  });
  let refreshCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (url === '/v1/auth/refresh') {
      refreshCalls += 1;
      return json({ error: 'Unexpected refresh' }, 401);
    }
    const token = new Headers(options.headers).get('Authorization');
    return json({}, token === 'Bearer access-a' ? 401 : 200);
  };
  await held.promise;
  const request = auth.authenticatedFetch('/v1/me');
  try {
    await nextTurn();
    localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access-b', refreshToken: 'refresh-b', provider: 'password', user: { userId: 'a' } }));
    release.resolve();
    assert.equal((await request).status, 200);
    assert.equal(refreshCalls, 0, 'the already-rotated token was refreshed again');
  } finally {
    release.resolve();
    await Promise.allSettled([request, lock]);
  }
});

test('cancelling one request does not cancel a sibling’s shared refresh', async () => {
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access-a', refreshToken: 'refresh-a', provider: 'password', user: { userId: 'a' } }));
  const winner = deferred();
  const refreshStarted = deferred();
  const controller = new AbortController();
  let refreshCalls = 0;
  let refreshSignal;
  globalThis.fetch = async (url, options) => {
    if (url === '/v1/auth/refresh') {
      refreshCalls += 1;
      refreshSignal = options.signal;
      refreshStarted.resolve();
      return winner.promise;
    }
    const token = new Headers(options.headers).get('Authorization');
    return json({}, token === 'Bearer access-a' ? 401 : 200);
  };
  const first = auth.authenticatedFetch('/v1/me', { signal: controller.signal });
  const second = auth.authenticatedFetch('/v1/sync');
  try {
    await refreshStarted.promise;
    await nextTurn();
    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(refreshSignal.aborted, false, 'the remaining request still needs the refresh');
    winner.resolve(json({ accessToken: 'access-b', refreshToken: 'refresh-b' }));
    assert.equal((await second).status, 200);
    assert.equal(refreshCalls, 1);
  } finally {
    controller.abort();
    winner.resolve(json({ accessToken: 'access-b', refreshToken: 'refresh-b' }));
    await Promise.allSettled([first, second]);
  }
});

test('a request that 401s as a cancelled refresh unwinds starts its own refresh', async () => {
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access-a', refreshToken: 'refresh-a', provider: 'password', user: { userId: 'a' } }));
  const refreshStarted = deferred();
  const late401 = deferred();
  const controller = new AbortController();
  let refreshCalls = 0;
  globalThis.fetch = (url, options) => {
    if (url === '/v1/auth/refresh') {
      refreshCalls += 1;
      refreshStarted.resolve();
      if (refreshCalls > 1) return Promise.resolve(json({ accessToken: 'access-b', refreshToken: 'refresh-b' }));
      // Like fetch: a cancelled request rejects with its signal's reason.
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    const token = new Headers(options.headers).get('Authorization');
    if (url === '/v1/sync' && token === 'Bearer access-a') return late401.promise;
    return Promise.resolve(json({}, token === 'Bearer access-a' ? 401 : 200));
  };
  const first = auth.authenticatedFetch('/v1/me', { signal: controller.signal });
  const second = auth.authenticatedFetch('/v1/sync').then(response => response.status, error => `rejected: ${error.name}`);
  try {
    await refreshStarted.promise;
    // The refresh's only waiter cancels, and a sibling's 401 lands in the same turn.
    controller.abort();
    late401.resolve(json({}, 401));
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(await second, 200, 'the second request inherited the first request’s cancellation');
    assert.equal(refreshCalls, 2);
  } finally {
    controller.abort();
    late401.resolve(json({}, 401));
    await Promise.allSettled([first, second]);
  }
});
