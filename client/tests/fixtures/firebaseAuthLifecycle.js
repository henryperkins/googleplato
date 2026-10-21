import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function loadAuth() {
  const cleanup = deferred();
  const firebaseUser = { uid: 'b', getIdToken: async () => 'id-token-b' };
  const auth = { currentUser: { uid: 'a' } };
  let popupCalls = 0;
  let signOutCalls = 0;
  const sdk = {
    getAuth: () => auth,
    GoogleAuthProvider: class { setCustomParameters() {} },
    signInWithPopup: () => {
      popupCalls += 1;
      auth.currentUser = firebaseUser;
      return Promise.resolve({ user: firebaseUser });
    },
    signOut: async () => {
      signOutCalls += 1;
      await cleanup.promise;
      auth.currentUser = null;
    },
    onAuthStateChanged: () => {},
  };
  const dependencies = {
    'firebase/app': { initializeApp: () => ({}) },
    'firebase/auth': sdk,
    '../../firebase-applet-config.json': { default: {} },
  };
  const source = await readFile(new URL('../../js/firebaseAuth.js', import.meta.url), 'utf8');
  const module = new SourceTextModule(source);
  await module.link(specifier => {
    const exports = dependencies[specifier];
    assert.ok(exports, `unexpected dependency: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    });
  });
  await module.evaluate();
  return { api: module.namespace, cleanup, auth, counts: () => ({ popupCalls, signOutCalls }) };
}

test('an in-flight Firebase sign-out cannot overlap the next Google popup', async () => {
  const { api, cleanup, auth, counts } = await loadAuth();
  const signOut = api.signOutFirebase();
  try {
    await assert.rejects(api.signInWithGooglePopup(), /sign-out.*finishing.*try again/i);
    assert.equal(counts().popupCalls, 0);
  } finally {
    cleanup.resolve();
    await signOut;
  }
  const signIn = api.signInWithGooglePopup();
  assert.equal(counts().popupCalls, 1, 'popup still opens synchronously on the next click');
  assert.equal((await signIn).idToken, 'id-token-b');
  assert.equal(auth.currentUser.uid, 'b');
});

test('concurrent sign-outs share cleanup until its actual completion', async () => {
  const { api, cleanup, counts } = await loadAuth();
  const first = api.signOutFirebase();
  const second = api.signOutFirebase();
  try {
    assert.equal(counts().signOutCalls, 1);
    await assert.rejects(api.signInWithGooglePopup());
  } finally {
    cleanup.resolve();
    await Promise.all([first, second]);
  }
  await api.signInWithGooglePopup();
  assert.equal(counts().popupCalls, 1);
});

test('failed Firebase cleanup releases the gate for a recoverable new sign-in', async () => {
  const { api, cleanup, counts } = await loadAuth();
  const signOut = api.signOutFirebase();
  cleanup.reject(new Error('storage unavailable'));
  await signOut;
  const signIn = api.signInWithGooglePopup();
  assert.equal(counts().popupCalls, 1);
  assert.equal((await signIn).firebaseUser.uid, 'b');
});
