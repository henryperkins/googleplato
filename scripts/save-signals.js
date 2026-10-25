// The save-failure signal, shared by scripts/log-watch.js and the Cloud
// Monitoring alert in deploy/cloudrun/monitoring.js so the two cannot drift.
// No imports: the alert generator runs from a checkout without npm install.
// See docs/SAVE_OBSERVABILITY.md.

export const SAVE_FAILURE_CODES = ['sync_conflict', 'sync_validation_failure', 'client_save_unconfirmed'];
// An unhandled error counts only on a learner-data write.
export const SYNC_WRITE_METHODS = ['PUT', 'POST', 'DELETE'];
export const SYNC_PATH_PREFIX = '/v1/sync';

const syncPath = new RegExp(`^${SYNC_PATH_PREFIX}(?:/|$)`);

export function isSaveFailure(code, meta = {}) {
  return SAVE_FAILURE_CODES.includes(code) || (code === 'unhandled_error'
    && SYNC_WRITE_METHODS.includes(String(meta.method).toUpperCase())
    && syncPath.test(meta.path || ''));
}
