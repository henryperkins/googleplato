/**
 * Remote storage sync — loads all server data into the in-memory cache on startup.
 * Individual writes are handled directly by storage.js via putSyncData.
 */

import { authenticatedFetch } from './auth.js';
import { clearCache, _populateCache } from './storage.js';

/**
 * Load all data from the server and populate the in-memory cache.
 * Compatible clients hydrate writable state only from the canonical server.
 * A superseded load must not replace the active session's cached data.
 */
export async function loadAll({ isCurrent = () => true } = {}) {
  const res = await authenticatedFetch('/v1/sync');
  if (!res.ok || !isCurrent()) return;

  const items = await res.json();
  if (!isCurrent()) return;
  clearCache();

  for (const { dataKey, data, version } of items) {
    _populateCache(dataKey, data, version);
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
