/**
 * Firebase Client Initialization & Cloud Firestore Sync Layer for plato.
 *
 * Responsibilities:
 * - Initializes Firebase App, Auth, and Firestore using firebase-applet-config.json
 * - Enforces structured FirestoreErrorInfo error reporting on all Firestore operations
 * - Provides Google Sign-In popup helper and Firestore sync Data helpers
 *   strictly adhering to firebase-blueprint.json & firestore.rules constraints
 *
 * This module is ~170 KB gzipped, so it is only ever imported dynamically:
 * by Google sign-in, and by sync for sessions that signed in with Google
 * (see `usesFirebase` in storage.js). Password sessions never load it.
 */

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

// Validation bounds synchronized verbatim with firebase-blueprint.json & firestore.rules
const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 120;
const MAX_USERNAME_LEN = 30;
const MAX_GROUP_LEN = 100;
const MAX_EMAIL_LEN = 254;
const MAX_PAYLOAD_LEN = 389120;

/**
 * Sanitize an arbitrary syncKey (e.g. `lessonKB:intro-1`) into a valid Firestore
 * document ID matching `^[a-zA-Z0-9_\-]+$` with max length 128.
 */
export function toFirestoreSyncId(syncKey) {
  if (!syncKey || typeof syncKey !== 'string') return 'invalid_key';
  const sanitized = syncKey
    .replace(/:/g, '__')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, MAX_ID_LEN);
  return sanitized || 'empty_key';
}

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/**
 * The signed-in Firebase user once Firebase has restored any persisted
 * session. Reading `auth.currentUser` straight after a lazy import returns
 * null until that restore finishes, which would silently skip mirroring.
 */
async function restoredUser() {
  await auth.authStateReady();
  return auth.currentUser;
}

/**
 * Sign in with Google Popup and return the Firebase user + ID token.
 */
export async function signInWithGooglePopup() {
  const result = await signInWithPopup(auth, googleProvider);
  const idToken = await result.user.getIdToken();
  return { firebaseUser: result.user, idToken };
}

/**
 * Sign out of Firebase Auth if signed in.
 */
export async function signOutFirebase() {
  try {
    if (auth.currentUser) {
      await firebaseSignOut(auth);
    }
  } catch {
    // Non-fatal on logout
  }
}

/**
 * Ensure the authenticated Firebase user's profile and isolated PII record
 * exist in Firestore (`users/{uid}` and `users/{uid}/private/info`).
 */
export async function ensureFirestoreUserProfile(platoUser) {
  const currentUser = await restoredUser();
  if (!currentUser || !currentUser.emailVerified || !platoUser) return;

  const uid = currentUser.uid;
  if (!ID_REGEX.test(uid) || uid.length > MAX_ID_LEN) return;

  const rawPlatoId = String(platoUser.userId || uid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_ID_LEN);
  const safeName = String(platoUser.name || currentUser.displayName || 'Learner').trim().slice(0, MAX_NAME_LEN) || 'Learner';
  const rawUsername = String(platoUser.username || 'user_1').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_USERNAME_LEN);
  const safeUsername = rawUsername.length >= 3 ? rawUsername : `usr_${rawUsername}`;
  const safeRole = platoUser.role === 'admin' ? 'admin' : 'user';
  const safeGroup = platoUser.userGroup ? String(platoUser.userGroup).slice(0, MAX_GROUP_LEN) : null;

  const userPath = `users/${uid}`;
  const userRef = doc(db, 'users', uid);

  let existingSnap;
  try {
    existingSnap = await getDoc(userRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, userPath);
  }

  if (!existingSnap?.exists()) {
    // If the user is an admin and doesn't match the runtime bootstrap email,
    // role in Firestore defaults to 'user' unless they have an /admins/{uid} record.
    let firestoreRole = 'user';
    if (safeRole === 'admin' && (currentUser.email === 'allthesecrushes@gmail.com' || currentUser.email === 'henry@lakefrontdigital.io')) {
      firestoreRole = 'admin';
    }
    const payload = {
      uid,
      platoUserId: rawPlatoId,
      name: safeName,
      username: safeUsername,
      role: firestoreRole,
      ...(safeGroup ? { userGroup: safeGroup } : {}),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    try {
      await setDoc(userRef, payload);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, userPath);
    }
  } else {
    const updatePayload = {
      name: safeName,
      username: safeUsername,
      ...(safeGroup ? { userGroup: safeGroup } : {}),
      updatedAt: serverTimestamp(),
    };
    try {
      await updateDoc(userRef, updatePayload);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, userPath);
    }
  }

  // Sync isolated PII record under users/{uid}/private/info
  const email = String(platoUser.email || currentUser.email || '').trim().slice(0, MAX_EMAIL_LEN);
  if (email.length >= 3) {
    const privatePath = `users/${uid}/private/info`;
    const privateRef = doc(db, 'users', uid, 'private', 'info');
    let privateSnap;
    try {
      privateSnap = await getDoc(privateRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, privatePath);
    }

    if (!privateSnap?.exists()) {
      try {
        await setDoc(privateRef, {
          uid,
          email,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, privatePath);
      }
    } else if (privateSnap.data()?.email !== email) {
      try {
        await updateDoc(privateRef, {
          email,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, privatePath);
      }
    }
  }
}

/**
 * Mirror a plato sync record (`users/{uid}/syncData/{syncId}`) to Cloud Firestore.
 */
export async function mirrorSyncDataToFirestore(syncKey, data) {
  const currentUser = await restoredUser();
  if (!currentUser || !currentUser.emailVerified) return;

  const uid = currentUser.uid;
  const syncId = toFirestoreSyncId(syncKey);
  if (!ID_REGEX.test(uid) || !ID_REGEX.test(syncId)) return;

  const serialized = JSON.stringify({ syncKey, data });
  if (!serialized || serialized.length > MAX_PAYLOAD_LEN) return;

  const path = `users/${uid}/syncData/${syncId}`;
  const ref = doc(db, 'users', uid, 'syncData', syncId);

  let existingSnap;
  try {
    existingSnap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (!existingSnap?.exists()) {
    try {
      await setDoc(ref, {
        uid,
        dataKey: syncId,
        payload: serialized,
        version: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  } else {
    const currentVersion = Number(existingSnap.data()?.version) || 1;
    try {
      await updateDoc(ref, {
        payload: serialized,
        version: currentVersion + 1,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  }
}

/**
 * Delete a mirrored sync record from Cloud Firestore.
 */
export async function deleteSyncDataFromFirestore(syncKey) {
  const currentUser = await restoredUser();
  if (!currentUser || !currentUser.emailVerified) return;

  const uid = currentUser.uid;
  const syncId = toFirestoreSyncId(syncKey);
  if (!ID_REGEX.test(uid) || !ID_REGEX.test(syncId)) return;

  const path = `users/${uid}/syncData/${syncId}`;
  const ref = doc(db, 'users', uid, 'syncData', syncId);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await deleteDoc(ref);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

/**
 * Load all mirrored sync records for the authenticated Firebase user from Firestore.
 */
export async function loadAllSyncDataFromFirestore() {
  const currentUser = await restoredUser();
  if (!currentUser || !currentUser.emailVerified) return [];

  const uid = currentUser.uid;
  const path = `users/${uid}/syncData`;
  const colRef = collection(db, 'users', uid, 'syncData');
  try {
    const snap = await getDocs(colRef);
    const results = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      if (d?.payload) {
        try {
          const parsed = JSON.parse(d.payload);
          if (parsed?.syncKey && parsed.data !== undefined) {
            results.push({
              dataKey: parsed.syncKey,
              data: parsed.data,
              version: d.version || 1,
            });
          }
        } catch {
          // Ignore malformed payload
        }
      }
    });
    return results;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
    return [];
  }
}

/**
 * Subscribe to real-time updates on the user's Firestore syncData subcollection.
 */
export function subscribeToFirestoreSync(onRecordChange) {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.emailVerified) return () => {};

  const uid = currentUser.uid;
  const path = `users/${uid}/syncData`;
  const colRef = collection(db, 'users', uid, 'syncData');

  return onSnapshot(
    colRef,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const d = change.doc.data();
          if (d?.payload) {
            try {
              const parsed = JSON.parse(d.payload);
              if (parsed?.syncKey && parsed.data !== undefined) {
                onRecordChange(parsed.syncKey, parsed.data, d.version || 1);
              }
            } catch {
              // Ignore malformed JSON
            }
          }
        }
      });
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export { onAuthStateChanged };
