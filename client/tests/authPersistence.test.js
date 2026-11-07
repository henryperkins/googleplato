import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
};
globalThis.sessionStorage = { getItem: () => null, removeItem() {} };
const auth = await import('../js/auth.js');
const session = id => ({ accessToken: `access-${id}`, refreshToken: `refresh-${id}`, user: { userId: id }, provider: 'password' });
let revoked;
beforeEach(async () => {
  values.clear();
  revoked = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/v1/auth/logout') revoked.push(JSON.parse(options.body).refreshToken);
    return Response.json(url === '/v1/auth/login' ? session('b') : {});
  };
  await auth.logout();
  values.clear();
});

for (const name of ['QuotaExceededError', 'SecurityError']) for (const previous of [false, true]) {
  for (const method of ['password', 'external']) {
    test(`${method} rejects ${name} with prior account ${previous} without publishing or leaking its token`, async () => {
      if (previous) values.set('plato_auth', JSON.stringify(session('a')));
      const before = values.get('plato_auth');
      const write = localStorage.setItem;
      localStorage.setItem = (key, value) => {
        if (key === 'plato_auth') throw new DOMException('Storage blocked', name);
        write(key, value);
      };
      try {
        await assert.rejects(method === 'password' ? auth.login('b', 'password') : auth.adoptAuthSession(session('b'), 'google-auth'),
          error => error.code === 'auth_storage_unavailable' && /storage|browser/i.test(error.message));
        assert.equal(values.get('plato_auth'), before);
        assert.deepEqual(revoked, ['refresh-b']);
      } finally { localStorage.setItem = write; }
    });
  }
}

for (const record of [{ accessToken: 'stale' }, { accessToken: 'a', refreshToken: 'r', user: null },
  { accessToken: 42, refreshToken: 'r', user: { userId: 'a' } },
  { accessToken: 'a', refreshToken: 42, user: { userId: 'a' } },
  { accessToken: 'a', refreshToken: 'r', user: { userId: 42 } }, {}, [], null]) {
  test(`invalid stored record ${JSON.stringify(record)} is discarded while drafts survive`, async () => {
    values.set('plato_auth', JSON.stringify(record));
    values.set('plato_auth_attempt', '{"attemptId":42}');
    values.set('owned-draft', 'Keep this work');
    assert.equal(await auth.isLoggedIn(), false);
    assert.equal(values.has('plato_auth'), false);
    assert.equal(values.has('plato_auth_attempt'), false);
    assert.equal(values.get('owned-draft'), 'Keep this work');
  });
}

test('legacy complete sessions initialize without changing their identity or credentials', async () => {
  const record = JSON.stringify(session('legacy'));
  values.set('plato_auth', record);
  const generation = auth.getSessionGeneration();
  assert.equal(await auth.isLoggedIn(), true);
  assert.equal(values.get('plato_auth'), record);
  assert.equal(auth.getSessionGeneration(), generation);
});

test('a denied session write releases the native auth lock before another attempt', { skip: !globalThis.navigator?.locks }, async () => {
  const write = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === 'plato_auth') throw new DOMException('Storage blocked', 'QuotaExceededError');
    write(key, value);
  };
  try {
    await assert.rejects(auth.adoptAuthSession(session('b'), 'google-auth'), { code: 'auth_storage_unavailable' });
    const locks = await navigator.locks.query();
    assert.equal(locks.held.filter(lock => lock.name === 'plato:auth-session').length, 0);
  } finally { localStorage.setItem = write; }
  assert.equal((await auth.adoptAuthSession(session('b'), 'google-auth')).userId, 'b');
});

test('invalid hydration preserves a valid pending intent for another sign-in', async () => {
  const intent = JSON.stringify({ attemptId: 'b'.repeat(32), epoch: 1 });
  values.set('plato_auth', '{}');
  values.set('plato_auth_attempt', intent);
  assert.equal(await auth.isLoggedIn(), false);
  assert.equal(values.has('plato_auth'), false);
  assert.equal(values.get('plato_auth_attempt'), intent);
});

test('logout removes credentials and invalidates attempts when quota prevents an intent write', async () => {
  values.set('plato_auth', JSON.stringify(session('a')));
  values.set('plato_auth_attempt', JSON.stringify({ attemptId: 'a'.repeat(32), epoch: 1 }));
  const write = localStorage.setItem;
  localStorage.setItem = () => { throw new DOMException('Full storage', 'QuotaExceededError'); };
  try {
    await auth.logout();
    assert.equal(values.has('plato_auth'), false);
    assert.equal(values.has('plato_auth_attempt'), false);
    assert.deepEqual(revoked, ['refresh-a']);
  } finally { localStorage.setItem = write; }
});

test('a refused credential removal rejects logout and keeps local requests fenced', async () => {
  values.set('plato_auth', JSON.stringify(session('a')));
  const remove = localStorage.removeItem;
  localStorage.removeItem = key => {
    if (key === 'plato_auth') throw new DOMException('Storage blocked', 'SecurityError');
    remove(key);
  };
  try {
    await assert.rejects(auth.logout(), { name: 'SecurityError' });
    await assert.rejects(auth.authenticatedFetch('/v1/me'), /session|account|sign.in/i);
    assert.deepEqual(revoked, ['refresh-a']);
  } finally { localStorage.removeItem = remove; }
});
