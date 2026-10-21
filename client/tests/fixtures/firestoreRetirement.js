import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';

const original = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
const browserStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => Object.assign(globalThis, original));

async function loadClient(provider = 'firebase') {
  globalThis.window = {};
  globalThis.localStorage = browserStorage();
  globalThis.sessionStorage = browserStorage();
  const user = { userId: 'learner', name: 'Learner', email: 'learner@example.test' };
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', provider, user }));
  const effects = [];
  const requests = [];
  const records = new Map();
  let rejectWrites = false;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (url === '/v1/client-events') return json({ accepted: true }, 202);
    if (url === '/v1/auth/firebase') return json({ accessToken: 'google-access', refreshToken: 'google-refresh', user });
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

  // Execute the actual auth/storage/sync graph. Only the external Firebase
  // boundary is substituted, including the old dynamically imported module so
  // the test also runs after that module is retired from production.
  const external = async exports => {
    const module = new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    });
    await module.link(() => { throw new Error('Unexpected external dependency'); });
    await module.evaluate();
    return module;
  };
  const firebaseAuth = await external({
    signInWithGooglePopup: async () => ({ idToken: 'verified-google-token' }),
    signOutFirebase: async () => {},
  });
  const firestore = await external({
    ensureFirestoreUserProfile: async () => { effects.push('profile'); },
    mirrorSyncDataToFirestore: async () => { effects.push('write'); },
    deleteSyncDataFromFirestore: async () => { effects.push('delete'); },
    loadAllSyncDataFromFirestore: async () => { effects.push('backfill'); return []; },
    subscribeToFirestoreSync: () => { effects.push('subscribe'); return () => {}; },
  });
  const modules = new Map();
  for (const file of ['auth.js', 'storage.js', 'sync.js', 'clientCompatibility.js', 'saveObservability.js']) {
    const url = new URL(`../../js/${file}`, import.meta.url);
    const source = await readFile(url, 'utf8');
    modules.set(url.href, new SourceTextModule(source, {
      identifier: url.href,
      importModuleDynamically: async specifier => {
        if (specifier === './firebaseAuth.js') return firebaseAuth;
        if (specifier === './firebaseClient.js') return firestore;
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
  return { auth: api('auth.js'), storage: api('storage.js'), sync: api('sync.js'), records, effects, requests, rejectWrites: () => { rejectWrites = true; } };
}

test('Google sign-in exchanges the verified token without creating a Firestore profile', async () => {
  const client = await loadClient();
  const user = await client.auth.loginWithGoogle({ inviteToken: 'invite' });
  assert.equal(user.userId, 'learner');
  assert.equal((await client.storage.getAuthTokens()).accessToken, 'google-access');
  assert.equal(await client.storage.usesFirebase(), true);
  assert.deepEqual(client.requests[0], { url: '/v1/auth/firebase', method: 'POST', body: { idToken: 'verified-google-token', inviteToken: 'invite' } });
  assert.deepEqual(client.effects, []);
});

for (const provider of ['firebase', 'password']) {
  test(`${provider} saves, atomic acknowledgements and deletes affect only server state`, async () => {
    const { storage, records, effects } = await loadClient(provider);
    assert.equal(await storage.putSyncData('profile', { name: 'Saved learner' }), true);
    assert.deepEqual(records.get('profile'), { data: { name: 'Saved learner' }, version: 1 });
    storage.acceptSavedLessonState('lesson', { messages: { data: [{ id: 'turn:0', role: 'assistant', content: 'Saved reply' }], version: 2 }, lessonKB: { data: { progress: 4 }, version: 2 } });
    assert.equal((await storage.getLessonMessages('lesson'))[0].id, 'turn:0');
    await storage.clearLessonMessages('lesson');
    assert.deepEqual(await storage.getLessonMessages('lesson'), []);
    await nextTurn();
    assert.deepEqual(effects, []);
  });

  test(`${provider} resets and server edits stay authoritative after reload`, async () => {
    const { storage, sync, records, effects } = await loadClient(provider);
    records.set('messages:lesson', { data: [{ id: 'old', content: 'Old conversation' }], version: 4 });
    await sync.loadAll();
    assert.equal((await storage.getLessonMessages('lesson'))[0].id, 'old');
    records.clear();
    await sync.loadAll();
    assert.deepEqual(await storage.getLessonMessages('lesson'), []);
    records.set('messages:lesson', { data: [{ id: 'admin-edit', content: 'Canonical edit' }], version: 1 });
    await sync.loadAll();
    assert.equal((await storage.getLessonMessages('lesson'))[0].id, 'admin-edit');
    assert.deepEqual(effects, []);
  });

  test(`${provider} failed saves retain the local reply without copying it to Firestore`, async () => {
    const client = await loadClient(provider);
    client.rejectWrites();
    const reply = [{ id: 'pending:0', role: 'assistant', content: 'Keep this reply', timestamp: 100 }];
    assert.equal(await client.storage.saveLessonMessages('lesson', reply), false);
    assert.deepEqual(await client.storage.getLessonMessages('lesson'), reply);
    assert.equal(client.records.has('messages:lesson'), false);
    await nextTurn();
    assert.deepEqual(client.effects, []);
  });
}
