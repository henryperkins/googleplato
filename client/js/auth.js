/**
 * Authentication module for plato.
 * Handles login, logout, token refresh, and authenticated requests.
 */

import {
  getAuthTokens, saveAuthTokens, clearAuth,
  saveAuthUser, saveAuthSession, clearCache,
} from './storage.js';
import { beginAuthAttempt, commitAuthAttempt, invalidateAuthAttempts, reconcileInvalidAuthSession } from './authCoordination.js';
import { compatibilityHeaders, isCompatibilityPath, requireClientUpgrade } from './clientCompatibility.js';

// When served from the same origin (Lambda), use relative paths.
// Falls back to the Lambda Function URL for local development.
const SERVICE_URL = globalThis.__SERVICE_URL || '';
const LOGOUT_CLEANUP_TIMEOUT_MS = 5000;
let sessionGeneration = 0;

// "View as User" admin feature: when an admin starts an impersonation session,
// the target's userId is stashed in sessionStorage (per-tab, doesn't survive
// close — safer than localStorage). authenticatedFetch reads this and appends
// `?asUserId=<id>` to GET requests. Writes never carry the param; the server
// rejects them as a defense-in-depth.
const IMPERSONATION_KEY = 'plato_impersonation';

function readImpersonatedUserId() {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(IMPERSONATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.userId || null;
  } catch {
    return null;
  }
}

export function getImpersonation() {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(IMPERSONATION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setImpersonation(target) {
  if (typeof sessionStorage === 'undefined') return;
  if (target) {
    sessionStorage.setItem(IMPERSONATION_KEY, JSON.stringify(target));
  } else {
    sessionStorage.removeItem(IMPERSONATION_KEY);
  }
}

function appendQueryParam(path, key, value) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${key}=${encodeURIComponent(value)}`;
}

// -- Session expiry event -----------------------------------------------------

const _sessionExpiredListeners = new Set();

/**
 * Register a listener called when the session expires on another device
 * (refresh token was rotated). The listener receives no arguments.
 * Returns an unsubscribe function.
 */
export function onSessionExpired(fn) {
  _sessionExpiredListeners.add(fn);
  return () => _sessionExpiredListeners.delete(fn);
}

function _notifySessionExpired() {
  for (const fn of _sessionExpiredListeners) {
    try { fn(); } catch { /* listener errors must not propagate */ }
  }
}

function staleSignIn() {
  const error = new Error('You started another sign-in or signed out in this browser. Try again.');
  error.code = 'stale_auth_exchange';
  return error;
}

/**
 * Log in with email and password.
 * Returns the user object on success, throws on failure.
 *
 * The newest sign-in or sign-out owns the stored credentials. A response that
 * arrives after another one started must not replace them: React would keep
 * showing the newer account while every request authenticated as this one.
 * Such a response is discarded (its refresh token revoked, best effort) and
 * the call rejects with `code: 'stale_auth_exchange'`.
 */
export async function login(email, password, attemptId) {
  const generation = ++sessionGeneration;
  attemptId ||= await beginAuthAttempt();
  const res = await fetch(`${SERVICE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || 'Login failed');
    err.status = res.status;
    throw err;
  }
  const session = await res.json();
  return commitSession(session, 'password', attemptId, generation);
}

/** Reject an unadopted provider/password session without touching the winner. */
export function rejectStaleAuthSession(session) {
  if (session?.refreshToken) void revokeSession(session.refreshToken);
  throw staleSignIn();
}

async function commitSession(session, provider, attemptId, generation) {
  let committed;
  try {
    committed = await commitAuthAttempt(attemptId, () => {
      if (generation !== sessionGeneration) return;
      if (!saveAuthSession({
        accessToken: session.accessToken, refreshToken: session.refreshToken,
        user: session.user, provider, attemptId,
      })) {
        const error = new Error('Your browser could not save your sign-in. Allow browser storage and try again.');
        error.code = 'auth_storage_unavailable';
        throw error;
      }
      observedIdentity = readCommittedIdentity();
      sessionNeedsReload = false;
    });
  } catch (error) {
    // The Web Lock has been released; revoke only this unadopted session.
    if (error.code === 'auth_storage_unavailable' && session.refreshToken) void revokeSession(session.refreshToken);
    throw error;
  }
  if (!committed || generation !== sessionGeneration) return rejectStaleAuthSession(session);
  return session.user;
}

/** Adopt a server session using the intent captured before its exchange began. */
export async function adoptAuthSession(session, provider, attemptId) {
  if (!session?.accessToken || !session?.refreshToken || !session?.user?.userId) {
    throw new Error('The sign-in provider returned an invalid session.');
  }
  const generation = ++sessionGeneration;
  attemptId ||= await beginAuthAttempt();
  return commitSession(session, provider || 'external', attemptId, generation);
}

/** End local access immediately; snapshot and remove credentials under the lock. */
export async function logout() {
  sessionGeneration += 1;
  sessionNeedsReload = true;
  let previousTokens;
  try {
    await invalidateAuthAttempts(() => {
      previousTokens = getAuthTokens();
      // Snapshot and removal both execute synchronously. Keep the local fence
      // if removal rejects, and consume the rejection instead of abandoning it.
      return clearAuth().then(() => {
        observedIdentity = null;
        sessionNeedsReload = false;
      });
    });
  } finally {
    const tokens = await previousTokens;
    if (tokens?.refreshToken) void revokeSession(tokens.refreshToken);
  }
}

async function revokeSession(refreshToken) {
  const controller = new AbortController();
  let timeout;
  try {
    await Promise.race([
      fetch(`${SERVICE_URL}/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal: controller.signal,
        keepalive: true,
      }),
      new Promise(resolve => {
        timeout = setTimeout(() => { controller.abort(); resolve(); }, LOGOUT_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch { /* Local access has already ended, even if revocation fails. */ }
  finally { clearTimeout(timeout); }
}

// External providers clean up their own popup state before session adoption.
// Ordinary plato logout is deliberately provider-independent.

/**
 * Check if the user is logged in (has stored tokens).
 */
export async function isLoggedIn() {
  let raw;
  try { raw = localStorage.getItem('plato_auth'); } catch { return false; }
  if (raw === null) return false;
  const parse = value => { try { return JSON.parse(value); } catch { return null; } };
  if (validStoredSession(parse(raw))) return true;
  try {
    await reconcileInvalidAuthSession(() => {
      const currentRaw = localStorage.getItem('plato_auth');
      if (currentRaw !== raw || validStoredSession(parse(currentRaw))) return false;
      const invalidAttempt = parse(currentRaw)?.attemptId;
      localStorage.removeItem('plato_auth');
      sessionGeneration += 1;
      observedIdentity = null;
      sessionNeedsReload = false;
      clearCache();
      try { setImpersonation(null); } catch { /* storage can be unavailable independently */ }
      return typeof invalidAttempt === 'string' ? invalidAttempt : null;
    });
    return validStoredSession(parse(localStorage.getItem('plato_auth')));
  } catch { return false; /* denied storage still settles initialization */ }
}

function validStoredSession(record) {
  return typeof record?.accessToken === 'string' && !!record.accessToken
    && typeof record?.refreshToken === 'string' && !!record.refreshToken
    && typeof record?.user?.userId === 'string' && !!record.user.userId.trim()
    && (record.attemptId === undefined || (typeof record.attemptId === 'string' && !!record.attemptId));
}

/**
 * Get the current user object, or null if not logged in.
 */
export { getAuthUser as getCurrentUser } from './storage.js';

/** An epoch distinguishes logout/re-login even when the owner is unchanged. */
export function getSessionGeneration() { return sessionGeneration; }

// Each tab tracks the committed login, not access-token rotations/profile edits.
const authChangeListeners = new Set();
let sessionNeedsReload = false;
function readCommittedIdentity() {
  try {
    const record = JSON.parse(localStorage.getItem('plato_auth'));
    if (typeof record?.accessToken !== 'string' || !record.accessToken
      || typeof record?.refreshToken !== 'string' || !record.refreshToken
      || typeof record?.user?.userId !== 'string' || !record.user.userId
      || (record.attemptId !== undefined && typeof record.attemptId !== 'string')) return null;
    return { userId: record.user.userId, attemptId: record.attemptId || null };
  } catch { return null; }
}
let observedIdentity = readCommittedIdentity();
export function onAuthChange(listener) {
  authChangeListeners.add(listener);
  return () => authChangeListeners.delete(listener);
}
if (typeof window !== 'undefined') window.addEventListener?.('storage', event => {
  if (event.key !== 'plato_auth' && event.key !== null) return;
  // The event can be queued behind newer writes. Read the whole current record
  // once instead of publishing its potentially stale newValue payload.
  const identity = readCommittedIdentity();
  if (identity?.userId === observedIdentity?.userId && identity?.attemptId === observedIdentity?.attemptId) return;
  observedIdentity = identity;
  sessionGeneration += 1;
  sessionNeedsReload = true;
  clearCache();
  for (const listener of authChangeListeners) listener(identity);
});

export async function captureAuthSession() {
  const generation = sessionGeneration;
  const tokens = await getAuthTokens();
  return !sessionNeedsReload && generation === sessionGeneration && tokens?.user?.userId
    ? { generation, userId: tokens.user.userId } : null;
}

export async function isAuthSessionCurrent(session) {
  if (sessionNeedsReload || !session || session.generation !== sessionGeneration) return false;
  const tokens = await getAuthTokens();
  return session.generation === sessionGeneration && tokens?.user?.userId === session.userId;
}

/** Best effort role/profile refresh. Never publish a body belonging to an old login. */
export async function refreshCurrentUser() {
  const session = await captureAuthSession();
  if (!session) return null;
  try {
    const response = await authenticatedFetch('/v1/me', { expectedUserId: session.userId });
    if (!response.ok) return null;
    const user = await response.json();
    const current = await getAuthTokens();
    if (session.generation !== sessionGeneration || current?.user?.userId !== session.userId
      || user?.userId !== session.userId) return null;
    // Storage checks the exact credentials again synchronously before writing.
    if (!await saveAuthUser(user, current)) return null;
    return await isAuthSessionCurrent(session) && session.generation === sessionGeneration ? user : null;
  } catch { return null; }
}

/**
 * Refresh the access token using the stored refresh token.
 * Returns true on success, false on failure (user must re-login).
 */
const sameSession = (left, right) => left?.user?.userId === right?.user?.userId
  && left?.accessToken === right?.accessToken && left?.refreshToken === right?.refreshToken;
const REFRESH_LOCK_NAME = 'plato:auth-refresh';
let refreshInFlight;

function abortReason(signal) {
  return signal?.reason || new DOMException('Request cancelled.', 'AbortError');
}

function withRefreshLock(callback, signal) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(REFRESH_LOCK_NAME, { mode: 'exclusive', signal }, callback) : callback();
}

function waitForRefresh(refresh, signal) {
  refresh.waiters += 1;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(abortReason(signal));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([refresh.promise, cancelled]).finally(() => {
    signal?.removeEventListener('abort', abort);
    refresh.waiters -= 1;
    // One caller cancelling must not interrupt its siblings. With no callers
    // left, stop waiting for the lock or the network as before.
    if (!refresh.settled && refresh.waiters === 0) refresh.controller.abort();
  });
}

async function runRefresh(refresh, tokens, generation) {
  try {
    return await withRefreshLock(() => doRefreshAccessToken(tokens, generation, refresh.controller.signal), refresh.controller.signal);
  } catch {
    if (refresh.controller.signal.aborted) throw abortReason(refresh.controller.signal);
    return false;
  }
}

function refreshAccessToken(tokens, generation, signal) {
  if (!tokens?.refreshToken) return false;
  let refresh = refreshInFlight;
  // A refresh whose last waiter cancelled is aborted but may not have settled
  // yet. A request that joins it then would inherit a cancellation it never asked for.
  if (!refresh || refresh.controller.signal.aborted || refresh.generation !== generation
    || !sameSession(refresh.tokens, tokens)) {
    refresh = { tokens, generation, controller: new AbortController(), waiters: 0, settled: false };
    refresh.promise = runRefresh(refresh, tokens, generation).finally(() => {
      refresh.settled = true;
      if (refreshInFlight === refresh) refreshInFlight = undefined;
    });
    refreshInFlight = refresh;
  }
  return waitForRefresh(refresh, signal);
}

async function doRefreshAccessToken(tokens, generation, signal) {
  // Another tab may have rotated the token while this caller waited for the
  // lock. The caller re-reads storage and reuses that rotation without a request.
  if (!sameSession(tokens, await getAuthTokens()) || generation !== sessionGeneration) return false;
  try {
    const res = await fetch(`${SERVICE_URL}/v1/auth/refresh`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (signal?.aborted) throw abortReason(signal);
    if (!res.ok) {
      // Don't clear auth silently — the user's data should be preserved.
      // Notify listeners so the UI can prompt re-login. A sibling rotation
      // means this rejection belongs to the old token, not the current session.
      if (sameSession(tokens, await getAuthTokens()) && generation === sessionGeneration) _notifySessionExpired();
      return false;
    }
    const { accessToken, refreshToken } = await res.json();
    if (signal?.aborted) throw abortReason(signal);
    // Compare and replace synchronously inside storage, after all awaits.
    // A late response must never merge account A's tokens into account B.
    if (generation !== sessionGeneration) return false;
    return await saveAuthTokens({ accessToken, refreshToken }, tokens);
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    return false;
  }
}

/**
 * Make an authenticated request to the plato server.
 * Automatically refreshes the access token on 401.
 */
export async function authenticatedFetch(path, options = {}) {
  if (sessionNeedsReload) throw new Error('The signed-in account changed. Reload the classroom.');
  const { expectedUserId, ...requestOptions } = options;
  options = requestOptions;
  const generation = sessionGeneration;
  const tokens = await getAuthTokens();
  if (!tokens?.accessToken) throw new Error('Not logged in');
  if (expectedUserId && tokens.user?.userId !== expectedUserId) throw new Error('The signed-in account changed. Return to the original account.');

  // GET-only impersonation: if an admin is "viewing as" a learner, attach
  // ?asUserId=<id> to reads. Writes never carry it — both as a client guard
  // and to match the server-side write rejection in /v1/sync.
  const method = (options.method || 'GET').toUpperCase();
  const protectedPath = isCompatibilityPath(path);
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (protectedPath && mutation && readImpersonatedUserId()) throw new Error('Writes are not allowed while viewing as another user.');
  let effectivePath = path;
  if (method === 'GET') {
    const asUserId = readImpersonatedUserId();
    if (asUserId) effectivePath = appendQueryParam(path, 'asUserId', asUserId);
  }

  const ownerOf = value => value?.user?.userId || value?.refreshToken || value?.accessToken;
  const owner = ownerOf(tokens);
  const fetchAsOwner = async (requestPath, requestOptions) => {
    let requestTokens;
    const doFetch = async () => {
      const current = await getAuthTokens();
      if (sessionNeedsReload || !current?.accessToken || ownerOf(current) !== owner || generation !== sessionGeneration) throw new Error('The signed-in account changed. Return to the original account.');
      const headers = new Headers(requestOptions.headers);
      headers.set('Authorization', `Bearer ${current.accessToken}`);
      requestTokens = current;
      return fetch(`${SERVICE_URL}${requestPath}`, { ...requestOptions, headers });
    };
    let response = await doFetch();
    if (response.status === 401) {
      const refreshed = await refreshAccessToken(requestTokens, generation, requestOptions.signal);
      const current = await getAuthTokens();
      // Reuse a sibling request's rotation only within this same login.
      if (!current || generation !== sessionGeneration || ownerOf(current) !== owner
        || (!refreshed && current.accessToken === requestTokens.accessToken)) throw new Error('Session expired');
      response = await doFetch();
    }
    if (ownerOf(await getAuthTokens()) !== owner || generation !== sessionGeneration) throw new Error('The signed-in account changed. Return to the original account.');
    return response;
  };
  const headers = new Headers(options.headers);
  const viewAs = readImpersonatedUserId();
  if (viewAs) headers.set('X-Plato-View-As', viewAs);
  if (protectedPath) {
    const compatibility = await compatibilityHeaders(async () => {
      // Use AbortController rather than newer AbortSignal composition helpers.
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal.reason);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => controller.abort(new DOMException('Checking for updates took too long.', 'TimeoutError')), 10_000);
      try {
        const response = await fetchAsOwner('/v1/sync/status', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Could not check for updates. Keep this page open and try again.');
        return await response.json();
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
      }
    }, { mutation });
    for (const [key, value] of Object.entries(compatibility)) headers.set(key, value);
  }
  const res = await fetchAsOwner(effectivePath, { ...options, headers });
  if (protectedPath && res.status === 409) {
    const body = await (res.clone?.() || res).json().catch(() => null);
    if (body?.code === 'client_upgrade_required') requireClientUpgrade();
  }
  return res;
}


/**
 * Request a password reset email. Sign-in checks plato's own password, so
 * plato's reset is the one that can change it. The server answers the same
 * way whether or not the address has an account.
 */
export async function forgotPassword(email) {
  const res = await fetch(`${SERVICE_URL}/v1/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email || '').trim() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Request failed');
  }
  const body = await res.json().catch(() => ({}));
  return { success: true, emailDelivery: body.emailDelivery };
}

/**
 * Update the authenticated user's profile (name, password, etc.).
 * Returns the updated user object. A password change revokes every session,
 * so the server returns a new token pair that keeps this device signed in.
 */
export async function updateProfile(updates, expectedUserId) {
  const generation = sessionGeneration;
  const owner = expectedUserId || (await getAuthTokens())?.user?.userId;
  const res = await authenticatedFetch('/v1/me', {
    expectedUserId: owner,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Update failed');
  }
  const { session, ...user } = await res.json();
  const current = await getAuthTokens();
  if (generation !== sessionGeneration || current?.user?.userId !== owner || user.userId !== owner) {
    throw new Error('The signed-in account changed. Return to the original account.');
  }
  if (session) {
    // Same compare-and-replace as refresh: a response that crosses logout or
    // an account switch must never restore or merge credentials.
    if (generation === sessionGeneration && current?.user?.userId === user.userId) {
      await saveAuthTokens(session, current);
    }
  }
  const latest = await getAuthTokens();
  if (generation !== sessionGeneration || latest?.user?.userId !== owner) {
    throw new Error('The signed-in account changed. Return to the original account.');
  }
  if (!await saveAuthUser(user, latest)) throw new Error('The signed-in account changed. Return to the original account.');
  return user;
}

/**
 * Admin-defined custom user fields (#364): definitions, the caller's values,
 * and the ids of required fields still missing. Always fetched fresh — the
 * cached auth user can't know an admin just added a required field.
 */
export async function getMyFields(expectedUserId) {
  const res = await authenticatedFetch('/v1/me/fields', { expectedUserId });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to load profile fields');
  }
  return res.json();
}

/**
 * Fetch the API key assigned by the admin (if any).
 * Returns the key string or null.
 */
export async function getAssignedApiKey() {
  const res = await authenticatedFetch('/v1/me/api-key');
  if (!res.ok) return null;
  const { apiKey } = await res.json();
  return apiKey || null;
}
