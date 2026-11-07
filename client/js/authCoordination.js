// This record contains no credentials or identity. Web Locks serialize writers;
// localStorage visibility across renderer processes still has a residual delay.
const ATTEMPT_KEY = 'plato_auth_attempt';
const LOCK_NAME = 'plato:auth-session';
let localEpoch = 0;
let localAttempt;
let warned = false;

function exclusive(write) {
  if (globalThis.navigator?.locks?.request) {
    // Returning a rejected promise also releases Node 24's native lock. The
    // callback still executes the storage write synchronously, before yielding.
    return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, async () => write());
  }
  if (!warned) {
    warned = true;
    console.warn('[plato] auth_coordination_unavailable: Web Locks unavailable; using per-tab and stored intent guards.');
  }
  // Keep the check and write synchronous even without cross-tab serialization.
  return Promise.resolve(write());
}

function recordIntent() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const attemptId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(ATTEMPT_KEY, JSON.stringify({ attemptId, epoch: ++localEpoch }));
  localAttempt = attemptId;
  return attemptId;
}

export function beginAuthAttempt() {
  return exclusive(recordIntent);
}

export function isAuthAttemptCurrent(attemptId) {
  if (!attemptId || (localAttempt && localAttempt !== attemptId)) return false;
  try { return JSON.parse(localStorage.getItem(ATTEMPT_KEY))?.attemptId === attemptId; }
  catch { return false; }
}

export function commitAuthAttempt(attemptId, write) {
  return exclusive(() => {
    if (!isAuthAttemptCurrent(attemptId)) return false;
    write();
    return true;
  });
}

// Optional synchronous callback keeps logout's snapshot/removal in this lock.
export function invalidateAuthAttempts(write = () => {}) {
  return exclusive(() => {
    try { recordIntent(); }
    catch {
      // Quota can block a new intent while removals still work. An absent
      // intent also fences every pending completion, and lets logout proceed.
      localAttempt = undefined;
      localStorage.removeItem(ATTEMPT_KEY);
    }
    return write();
  });
}

// The callback rechecks/removes only the invalid session under this lock and
// returns its attempt ID (or null). A different, valid pending intent survives.
export function reconcileInvalidAuthSession(clearSession) {
  return exclusive(() => {
    const invalidAttempt = clearSession();
    if (invalidAttempt === false) return;
    let intent;
    try { intent = JSON.parse(localStorage.getItem(ATTEMPT_KEY)); } catch { /* invalid record */ }
    if (!intent || typeof intent.attemptId !== 'string' || !Number.isSafeInteger(intent.epoch)
      || intent.epoch < 1 || intent.attemptId === invalidAttempt) {
      localStorage.removeItem(ATTEMPT_KEY);
      localAttempt = undefined;
    }
  });
}
