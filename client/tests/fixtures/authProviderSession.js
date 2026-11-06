import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';

const original = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
};
const browserStorage = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    clear: () => values.clear(),
  };
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const session = (provider = 'google-auth') => ({
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  provider,
  user: { userId: 'learner', name: 'Learner', email: 'learner@example.test' },
});

afterEach(() => Object.assign(globalThis, original));

async function loadCore() {
  globalThis.window = {};
  globalThis.localStorage = browserStorage();
  globalThis.sessionStorage = browserStorage();
  globalThis.fetch = async () => json({ ok: true });
  const dynamicImports = [];
  const modules = new Map();
  for (const file of ['auth.js', 'authCoordination.js', 'storage.js', 'clientCompatibility.js', 'saveObservability.js']) {
    const url = new URL(`../../js/${file}`, import.meta.url);
    modules.set(url.href, new SourceTextModule(await readFile(url, 'utf8'), {
      identifier: url.href,
      importModuleDynamically: async specifier => {
        dynamicImports.push(specifier);
        throw new Error(`Unexpected provider SDK import: ${specifier}`);
      },
    }));
  }
  for (const module of modules.values()) {
    if (module.status === 'unlinked') await module.link((specifier, parent) => {
      const dependency = modules.get(new URL(specifier, parent.identifier).href);
      assert.ok(dependency, `Unexpected dependency: ${specifier}`);
      return dependency;
    });
    if (module.status === 'linked') await module.evaluate();
  }
  const api = file => modules.get(new URL(`../../js/${file}`, import.meta.url).href).namespace;
  return { auth: api('auth.js'), storage: api('storage.js'), dynamicImports };
}

test('adoptAuthSession stores only the server-issued plato session and provider id', async () => {
  const { auth, storage, dynamicImports } = await loadCore();
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return json({ ok: true }); };
  const issued = session();
  const user = await auth.adoptAuthSession(issued, 'google-auth');
  assert.deepEqual(user, issued.user);
  const { attemptId, ...stored } = await storage.getAuthTokens();
  assert.match(attemptId, /^[a-f0-9]{32}$/);
  assert.deepEqual(stored, issued);
  assert.deepEqual(await storage.getAuthUser(), issued.user);
  assert.equal(requests, 0, 'session adoption does not call a provider or core exchange endpoint');
  assert.deepEqual(dynamicImports, []);
});

test('adoptAuthSession labels an unspecified external provider without loading an SDK', async () => {
  const { auth, storage, dynamicImports } = await loadCore();
  await auth.adoptAuthSession(session('external'));
  assert.equal((await storage.getAuthTokens()).provider, 'external');
  assert.deepEqual(dynamicImports, []);
});

test('adoptAuthSession rejects incomplete sessions without replacing the current account', async () => {
  const { auth, storage } = await loadCore();
  const existing = session('password');
  localStorage.setItem('plato_auth', JSON.stringify(existing));
  const incomplete = [
    null,
    {},
    { refreshToken: 'refresh', user: { userId: 'next' } },
    { accessToken: 'access', user: { userId: 'next' } },
    { accessToken: 'access', refreshToken: 'refresh' },
    { accessToken: 'access', refreshToken: 'refresh', user: {} },
  ];
  for (const candidate of incomplete) {
    await assert.rejects(auth.adoptAuthSession(candidate, 'google-auth'), /invalid session/);
  }
  assert.deepEqual(await storage.getAuthTokens(), existing);
});

for (const provider of ['password', 'google-auth']) {
  test(`${provider} logout revokes the plato session without dynamically importing Firebase`, async () => {
    const { auth, storage, dynamicImports } = await loadCore();
    localStorage.setItem('plato_auth', JSON.stringify(session(provider)));
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return json({ ok: true });
    };
    await auth.logout();
    await nextTurn();
    assert.equal(await storage.getAuthTokens(), null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/auth/logout');
    assert.equal(JSON.parse(requests[0].options.body).refreshToken, 'refresh-token');
    assert.deepEqual(dynamicImports, [], 'ordinary logout never loads the Firebase or google-auth client');
  });
}
