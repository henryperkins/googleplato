import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, onSnapshot, serverTimestamp, setDoc, setLogLevel, updateDoc } from 'firebase/firestore';

// An explicit emulator host is required; this suite never contacts production.
describe('retired Firestore client access', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, () => {
  let environment;
  const profile = { uid: 'owner', platoUserId: 'learner', name: 'Learner', username: 'learner', role: 'user', createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  const paths = [
    ['users/owner', profile],
    ['users/owner/private/info', { uid: 'owner', email: 'owner@example.test', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }],
    ['users/owner/syncData/messages__lesson', { uid: 'owner', dataKey: 'messages:lesson', payload: '[]', version: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }],
    ['admins/admin', { role: 'admin' }],
  ];

  before(async () => {
    setLogLevel('silent'); // Permission-denied writes are the assertions below.
    const host = new URL(`http://${process.env.FIRESTORE_EMULATOR_HOST}`);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname), 'Use a local disposable emulator');
    environment = await initializeTestEnvironment({
      projectId: `demo-plato-retirement-${process.pid}`,
      firestore: { host: host.hostname, port: Number(host.port), rules: await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8') },
    });
    await environment.withSecurityRulesDisabled(async context => {
      const database = context.firestore();
      for (const [path, data] of paths) await setDoc(doc(database, path), data);
    });
  });

  after(async () => { await environment?.cleanup(); });

  const identities = [
    ['anonymous', null],
    ['verified owner', { uid: 'owner', email: 'owner@example.test', email_verified: true }],
    ['bootstrap admin', { uid: 'bootstrap', email: 'bootstrap-admin@example.test', email_verified: true }],
    ['marker admin', { uid: 'admin', email: 'admin@example.test', email_verified: true }],
  ];
  for (const [name, identity] of identities) {
    for (const [path, data] of paths) {
      test(`${name} cannot read, list, create, update or delete ${path}`, async () => {
        const context = identity ? environment.authenticatedContext(identity.uid, { email: identity.email, email_verified: identity.email_verified }) : environment.unauthenticatedContext();
        const database = context.firestore();
        const reference = doc(database, path);
        await assertFails(getDoc(reference));
        await assertFails(getDocs(collection(database, path.split('/').slice(0, -1).join('/'))));
        await assertFails(setDoc(reference, data));
        await assertFails(updateDoc(reference, { updatedAt: serverTimestamp() }));
        await assertFails(deleteDoc(reference));
        await assertFails(setDoc(doc(database, `${path}-new`), data));
      });
    }
  }

  test('collection-group queries and new collections stay denied', async () => {
    const database = environment.authenticatedContext('owner', { email_verified: true }).firestore();
    await assertFails(getDocs(collectionGroup(database, 'syncData')));
    await assertFails(getDoc(doc(database, 'future/data')));
    await assertFails(setDoc(doc(database, 'future/data'), { data: 'No new mirror' }));
  });

  test('a stale owner subscription fails instead of delivering mirrored state', { timeout: 10000 }, async () => {
    const database = environment.authenticatedContext('owner', { email_verified: true }).firestore();
    let unsubscribe;
    try {
      const error = await new Promise((resolve, reject) => {
        unsubscribe = onSnapshot(doc(database, 'users/owner/syncData/messages__lesson'), () => reject(new Error('Retired mirror delivered a snapshot')), resolve);
      });
      assert.equal(error.code, 'permission-denied');
    } finally { unsubscribe?.(); }
  });
});
