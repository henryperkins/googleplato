import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';

const original = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
const browserStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => Object.assign(globalThis, original));

async function loadClient(provider = 'google-auth') {
  globalThis.window = {};
  globalThis.localStorage = browserStorage();
  globalThis.sessionStorage = browserStorage();
  const user = { userId: 'learner', name: 'Learner', email: 'learner@example.test' };
  if (provider) localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', provider, user }));
  const requests = [];
  const records = new Map();
  const dynamicImports = [];
  let rejectWrites = false;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (url === '/v1/client-events') return json({ accepted: true }, 202);
    if (url === '/v1/plugins/google-auth/exchange') return json({ accessToken: 'google-access', refreshToken: 'google-refresh', user });
    if (url === '/v1/sync/status') return json({ protocol: '1', epoch: 'retired' });
    if (url === '/v1/sync') return json([...records].map(([dataKey, item]) => ({ dataKey, ...item })));
    const key = decodeURIComponent(url.slice('/v1/sync/'.length));
    if (options.method === 'PUT') {
      if (rejectWrites) return json({ error: 'Save unavailable' }, 503);
      const body = JSON.parse(options.body);
      const item = { data: body.data, version: body.version + 1 };
      records.set(key, item);
      return json({ version: item.version });
    }
    if (options.method === 'DELETE') { records.delete(key); return json({ ok: true }); }
    return json(records.get(key) || { data: null, version: 0 });
  };

  // Execute the real plugin exchange and core auth/storage/sync graph. Any
  // dynamic provider SDK or Firestore import is an explicit test failure.
  const urls = [
    ...['auth.js', 'storage.js', 'sync.js', 'clientCompatibility.js', 'saveObservability.js']
      .map(file => new URL(`../../js/${file}`, import.meta.url)),
    new URL('../../../plugins/google-auth/client/exchange.js', import.meta.url),
  ];
  const modules = new Map();
  for (const url of urls) {
    modules.set(url.href, new SourceTextModule(await readFile(url, 'utf8'), {
      identifier: url.href,
      importModuleDynamically: async specifier => {
        dynamicImports.push(specifier);
        throw new Error(`Unexpected dynamic dependency: ${specifier}`);
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
  const exchange = modules.get(new URL('../../../plugins/google-auth/client/exchange.js', import.meta.url).href).namespace;
  return {
    auth: api('auth.js'), storage: api('storage.js'), sync: api('sync.js'), exchange,
    records, requests, dynamicImports, rejectWrites: () => { rejectWrites = true; },
  };
}

test('Google plugin exchange adopts a plato session without Firebase or a Firestore profile', async () => {
  const client = await loadClient(null);
  const issued = await client.exchange.exchangeGoogleToken('verified-google-token', { inviteToken: 'invite' });
  const user = await client.auth.adoptAuthSession(issued, 'google-auth');
  assert.equal(user.userId, 'learner');
  assert.equal((await client.storage.getAuthTokens()).accessToken, 'google-access');
  assert.equal((await client.storage.getAuthTokens()).provider, 'google-auth');
  assert.deepEqual(client.requests[0], {
    url: '/v1/plugins/google-auth/exchange',
    method: 'POST',
    body: { idToken: 'verified-google-token', inviteToken: 'invite' },
  });
  assert.deepEqual(client.dynamicImports, []);
});

for (const provider of ['google-auth', 'password']) {
  test(`${provider} saves, atomic acknowledgements and deletes affect only server state`, async () => {
    const { storage, records, dynamicImports } = await loadClient(provider);
    assert.equal(await storage.putSyncData('profile', { name: 'Saved learner' }), true);
    assert.deepEqual(records.get('profile'), { data: { name: 'Saved learner' }, version: 1 });
    storage.acceptSavedLessonState('lesson', { messages: { data: [{ id: 'turn:0', role: 'assistant', content: 'Saved reply' }], version: 2 }, lessonKB: { data: { progress: 4 }, version: 2 } });
    assert.equal((await storage.getLessonMessages('lesson'))[0].id, 'turn:0');
    await storage.clearLessonMessages('lesson');
    assert.deepEqual(await storage.getLessonMessages('lesson'), []);
    await nextTurn();
    assert.deepEqual(dynamicImports, []);
  });

  test(`${provider} resets and server edits stay authoritative after reload`, async () => {
    const { storage, sync, records, dynamicImports } = await loadClient(provider);
    records.set('messages:lesson', { data: [{ id: 'old', content: 'Old conversation' }], version: 4 });
    await sync.loadAll();
    assert.equal((await storage.getLessonMessages('lesson'))[0].id, 'old');
    records.clear();
    await sync.loadAll();
    assert.deepEqual(await storage.getLessonMessages('lesson'), []);
    records.set('messages:lesson', { data: [{ id: 'admin-edit', content: 'Canonical edit' }], version: 1 });
    await sync.loadAll();
    assert.equal((await storage.getLessonMessages('lesson'))[0].id, 'admin-edit');
    assert.deepEqual(dynamicImports, []);
  });

  test(`${provider} failed saves retain the local reply without a Firestore mirror`, async () => {
    const client = await loadClient(provider);
    client.rejectWrites();
    const reply = [{ id: 'pending:0', role: 'assistant', content: 'Keep this reply', timestamp: 100 }];
    assert.equal(await client.storage.saveLessonMessages('lesson', reply), false);
    assert.deepEqual(await client.storage.getLessonMessages('lesson'), reply);
    assert.equal(client.records.has('messages:lesson'), false);
    await nextTurn();
    assert.deepEqual(client.dynamicImports, []);
  });
}
