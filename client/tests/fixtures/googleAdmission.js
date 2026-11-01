import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';

const original = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
const browserStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => Object.assign(globalThis, original));

// Runs the real auth/storage module graph, signed out. Only the Firebase
// boundary (the lazily imported firebaseAuth.js) is substituted.
async function loadAuth(reply) {
  globalThis.window = {};
  globalThis.localStorage = browserStorage();
  globalThis.sessionStorage = browserStorage();
  globalThis.fetch = async (url) => (url === '/v1/auth/firebase' ? reply() : json({ ok: true }));
  const google = { signOuts: 0 };
  const firebaseAuth = new SyntheticModule(['signInWithGooglePopup', 'signOutFirebase'], function () {
    this.setExport('signInWithGooglePopup', async () => ({ idToken: 'verified-google-token' }));
    this.setExport('signOutFirebase', async () => { google.signOuts += 1; });
  });
  await firebaseAuth.link(() => { throw new Error('Unexpected external dependency'); });
  await firebaseAuth.evaluate();
  const modules = new Map();
  for (const file of ['auth.js', 'storage.js', 'clientCompatibility.js', 'saveObservability.js']) {
    const url = new URL(`../../js/${file}`, import.meta.url);
    modules.set(url.href, new SourceTextModule(await readFile(url, 'utf8'), {
      identifier: url.href,
      importModuleDynamically: async specifier => {
        if (specifier === './firebaseAuth.js') return firebaseAuth;
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
  return { auth: api('auth.js'), storage: api('storage.js'), google };
}

test('a Google account without an invitation is signed out and told where it stands', async () => {
  const { auth, storage, google } = await loadAuth(() => json({
    error: 'Membership is by invitation only. Ask your program admin for an invitation.',
    code: 'invite_required', email: 'new@example.test', name: 'New Learner', waitlisted: true, inviteExpired: false,
  }, 403));
  await assert.rejects(auth.loginWithGoogle(), err => {
    assert.equal(err.status, 403);
    assert.equal(err.code, 'invite_required');
    assert.deepEqual(err.admission, { email: 'new@example.test', name: 'New Learner', waitlisted: true, inviteExpired: false });
    return true;
  });
  assert.equal(google.signOuts, 1, 'the next attempt can choose another Google account');
  assert.equal(await storage.getAuthTokens(), null, 'no session was saved');
});

test('admission details keep only the expected types from the reply', async () => {
  const { auth } = await loadAuth(() => json({ code: 'invite_required', email: 42, name: null, waitlisted: 'yes', inviteExpired: 1 }, 403));
  await assert.rejects(auth.loginWithGoogle(), err => {
    assert.deepEqual(err.admission, { email: '', name: '', waitlisted: false, inviteExpired: false });
    return true;
  });
});

test('other Google sign-in failures carry no admission details', async () => {
  const { auth, google } = await loadAuth(() => json({ error: 'This invite is for a different email address' }, 400));
  await assert.rejects(auth.loginWithGoogle({ inviteToken: 'invite' }), err => {
    assert.equal(err.message, 'This invite is for a different email address');
    assert.equal(err.admission, undefined);
    return true;
  });
  assert.equal(google.signOuts, 1);
});
