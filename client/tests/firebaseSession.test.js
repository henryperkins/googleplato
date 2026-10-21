/**
 * Which sessions need Firebase Auth cleanup (storage.js `usesFirebase`).
 * Provider detection and legacy IndexedDB probing are retained for Google
 * sign-out; learner storage never uses this to load a data mirror.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = v; },
  removeItem(k) { delete this._store[k]; },
  clear() { this._store = {}; },
};

let databases = [];
let probes = 0;
globalThis.indexedDB = {
  async databases() {
    probes += 1;
    if (databases instanceof Error) throw databases;
    return databases;
  },
};

const { clearAuth, saveAuthProvider, usesFirebase } = await import('../js/storage.js');

describe('usesFirebase', () => {
  beforeEach(async () => {
    await clearAuth();
    databases = [];
    probes = 0;
  });

  it('trusts the provider recorded at sign-in without probing', async () => {
    saveAuthProvider('password');
    assert.equal(await usesFirebase(), false);
    saveAuthProvider('firebase');
    assert.equal(await usesFirebase(), true);
    assert.equal(probes, 0);
  });

  it('recognizes a Google session from before the provider was recorded', async () => {
    databases = [{ name: 'firebaseLocalStorageDb' }];
    assert.equal(await usesFirebase(), true);
  });

  it('keeps password-only sessions off the SDK', async () => {
    databases = [{ name: 'some-other-db' }];
    assert.equal(await usesFirebase(), false);
    databases = new Error('IndexedDB unavailable');
    await clearAuth();
    assert.equal(await usesFirebase(), false);
  });

  it('probes once per page session, and again after sign-out', async () => {
    await usesFirebase();
    await usesFirebase();
    assert.equal(probes, 1);
    await clearAuth();
    await usesFirebase();
    assert.equal(probes, 2);
  });

  it('does not cache an old detection result over a newer session’s provider', async () => {
    const originalProbe = indexedDB.databases;
    let release;
    indexedDB.databases = () => new Promise(resolve => { release = resolve; });
    try {
      const previous = usesFirebase();
      await clearAuth();
      saveAuthProvider('firebase');
      release([]);
      assert.equal(await previous, false, 'the result still describes the original probe');
      assert.equal(await usesFirebase(), true, 'the newer session keeps its recorded provider');
    } finally {
      indexedDB.databases = originalProbe;
    }
  });
});
