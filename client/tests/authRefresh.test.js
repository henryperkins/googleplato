// Two requests receive 401 at once. Without refresh coordination, the server's
// atomic consume accepts one refresh token and the other request signs out first.
import { test, mock } from 'node:test';
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

test('a refresh cancelled while it waits for the lock is never sent', { skip: !globalThis.navigator?.locks }, async () => {
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access-a', refreshToken: 'refresh-a', provider: 'password', user: { userId: 'a' } }));
  // Another tab holds the lock, so this tab's refresh waits unsent.
  const held = deferred();
  const release = deferred();
  const lock = navigator.locks.request('plato:auth-refresh', async () => {
    held.resolve();
    await release.promise;
  });
  const late401 = deferred();
  const controller = new AbortController();
  let refreshCalls = 0;
  globalThis.fetch = (url, options) => {
    if (url === '/v1/auth/refresh') {
      refreshCalls += 1;
      return Promise.resolve(json({ accessToken: 'access-b', refreshToken: 'refresh-b' }));
    }
    const token = new Headers(options.headers).get('Authorization');
    if (url === '/v1/sync' && token === 'Bearer access-a') return late401.promise;
    return Promise.resolve(json({}, token === 'Bearer access-a' ? 401 : 200));
  };
  await held.promise;
  const first = auth.authenticatedFetch('/v1/me', { signal: controller.signal });
  const second = auth.authenticatedFetch('/v1/sync').then(response => response.status, error => `rejected: ${error.name}`);
  try {
    await nextTurn();
    // The waiting refresh's only waiter cancels, and a sibling's 401 lands in the same turn.
    controller.abort();
    late401.resolve(json({}, 401));
    await assert.rejects(first, { name: 'AbortError' });
    release.resolve();
    assert.equal(await second, 200, 'the second request inherited the first request’s cancellation');
    assert.equal(refreshCalls, 1, 'the refresh cancelled before it was sent went out anyway');
  } finally {
    controller.abort();
    late401.resolve(json({}, 401));
    release.resolve();
    await Promise.allSettled([first, second, lock]);
  }
});

test('a sent refresh still saves its rotation when every waiter cancels', async () => {
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access-a', refreshToken: 'refresh-a', provider: 'password', user: { userId: 'a' } }));
  let expiredEvents = 0;
  const unsubscribe = auth.onSessionExpired(() => { expiredEvents += 1; });
  const winner = deferred();
  const refreshStarted = deferred();
  const consumed = new Set();
  const controller = new AbortController();
  let refreshCalls = 0;
  globalThis.fetch = (url, options) => {
    if (url === '/v1/auth/refresh') {
      refreshCalls += 1;
      // Like the server: each refresh token works once, and it's spent as soon as the request arrives.
      const { refreshToken } = JSON.parse(options.body);
      if (consumed.has(refreshToken)) return Promise.resolve(json({ error: 'Invalid refresh token' }, 401));
      consumed.add(refreshToken);
      refreshStarted.resolve();
      return winner.promise;
    }
    const token = new Headers(options.headers).get('Authorization');
    return Promise.resolve(json({}, token === 'Bearer access-a' ? 401 : 200));
  };
  const first = auth.authenticatedFetch('/v1/me', { signal: controller.signal });
  try {
    await refreshStarted.promise;
    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });
    // The server already rotated; its answer arrives after the only waiter left.
    winner.resolve(json({ accessToken: 'access-b', refreshToken: 'refresh-b' }));
    const later = await auth.authenticatedFetch('/v1/sync');
    assert.equal(later.status, 200);
    assert.equal(JSON.parse(localStorage.getItem('plato_auth')).refreshToken, 'refresh-b', 'the rotation was dropped');
    assert.equal(refreshCalls, 1, 'the spent token was sent again');
    assert.equal(expiredEvents, 0, 'session-expired fired although the session is fine');
  } finally {
    controller.abort();
    winner.resolve(json({ accessToken: 'access-b', refreshToken: 'refresh-b' }));
    unsubscribe();
    await Promise.allSettled([first]);
  }
});

test('a stalled refresh gives up at its deadline without signing out', async () => {
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access-a', refreshToken: 'refresh-a', provider: 'password', user: { userId: 'a' } }));
  let expiredEvents = 0;
  const unsubscribe = auth.onSessionExpired(() => { expiredEvents += 1; });
  const refreshStarted = deferred();
  let stalled = true;
  globalThis.fetch = (url, options) => {
    if (url === '/v1/auth/refresh') {
      if (!stalled) return Promise.resolve(json({ accessToken: 'access-b', refreshToken: 'refresh-b' }));
      refreshStarted.resolve();
      // Like fetch: an aborted request rejects with its signal's reason.
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    const token = new Headers(options.headers).get('Authorization');
    return Promise.resolve(json({}, token === 'Bearer access-a' ? 401 : 200));
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  const first = auth.authenticatedFetch('/first').then(response => response.status, error => `rejected: ${error.message}`);
  try {
    await refreshStarted.promise;
    mock.timers.tick(15_000);
    assert.equal(await first, 'rejected: Session expired');
    assert.equal(expiredEvents, 0, 'a timeout signed the learner out');
    // The lock is free again: the next request refreshes and succeeds.
    stalled = false;
    assert.equal((await auth.authenticatedFetch('/second')).status, 200);
  } finally {
    mock.timers.reset();
    unsubscribe();
    await Promise.allSettled([first]);
  }
});
