/**
 * Remote storage sync — loads all server data into the in-memory cache on startup.
 * Individual writes are handled directly by storage.js via putSyncData.
 */

import { authenticatedFetch } from './auth.js';
import { clearCache, _populateCache } from './storage.js';

let _firestoreUnsub = null;

/**
 * Load all data from the server and populate the in-memory cache.
 * Also merges and subscribes to Cloud Firestore syncData when signed in via Firebase Auth.
 */
export async function loadAll() {
  const res = await authenticatedFetch('/v1/sync');
  if (!res.ok) return;

  const items = await res.json();
  clearCache();

  for (const { dataKey, data, version } of items) {
    _populateCache(dataKey, data, version);
  }

  if (typeof window !== 'undefined') {
    try {
      const { loadAllSyncDataFromFirestore, subscribeToFirestoreSync } = await import('./firebaseClient.js');
      const firestoreItems = await loadAllSyncDataFromFirestore();
      for (const { dataKey, data, version } of firestoreItems) {
        if (!items.some((i) => i.dataKey === dataKey)) {
          _populateCache(dataKey, data, version);
        }
      }
      if (_firestoreUnsub) {
        try { _firestoreUnsub(); } catch { /* noop */ }
      }
      _firestoreUnsub = subscribeToFirestoreSync((syncKey, data, version) => {
        _populateCache(syncKey, data, version);
      });
    } catch {
      // Non-fatal if Firebase Auth is not active for password-only sessions
    }
  }
}

/**
 * Save a key to the server.
 * Now a no-op — storage.js write functions call putSyncData directly.
 * Kept for backward compatibility with syncInBackground.
 */
export async function save(_syncKey) {
  // No-op — writes are handled by storage.js putSyncData
}
