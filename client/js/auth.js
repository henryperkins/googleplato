/**
 * Authentication module for plato.
 * Handles login, logout, token refresh, and authenticated requests.
 */

import {
  getAuthTokens, saveAuthTokens, clearAuth,
  saveAuthUser, saveAuthProvider, usesFirebase,
} from './storage.js';
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
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(IMPERSONATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.userId || null;
  } catch {
    return null;
  }
}

export function getImpersonation() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
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

/**
 * Log in with email and password.
 * Returns the user object on success, throws on failure.
 */
export async function login(email, password) {
  sessionGeneration += 1;
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
  const { accessToken, refreshToken, user } = await res.json();
  await saveAuthTokens({ accessToken, refreshToken });
  await saveAuthUser(user);
  saveAuthProvider('password');
  return user;
}

/**
 * Preload only Firebase Auth ahead of a Google sign-in, so the popup
 * opens straight from the click (Safari blocks popups opened after a slow
 * await). Pages with a "Continue with Google" button call this once idle.
 */
export function preloadFirebase() {
  if (typeof window === 'undefined') return;
  const load = () => { import('./firebaseAuth.js').catch(() => {}); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 3000 });
  else setTimeout(load, 1000);
}

/**
 * Log in or onboard using Google Sign-In via Firebase Auth.
 * Bridges the verified Firebase ID token with `/v1/auth/firebase` and
 * initializes the user's Firestore profile.
 */
export async function loginWithGoogle(options = {}) {
  sessionGeneration += 1;
  const { signInWithGooglePopup, signOutFirebase } = await import('./firebaseAuth.js');
  const { idToken } = await signInWithGooglePopup();

  const res = await fetch(`${SERVICE_URL}/v1/auth/firebase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idToken,
      inviteToken: options.inviteToken || undefined,
      classroomName: options.classroomName || undefined,
      name: options.name || undefined,
      username: options.username || undefined,
      userGroup: options.userGroup || undefined,
      customFields: options.customFields || undefined,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    await signOutFirebase();
    const err = new Error(body.error || "Google sign-in didn't work. Try again.");
    err.code = body.code;
    err.email = body.email;
    throw err;
  }

  const { accessToken, refreshToken, user } = body;
  await saveAuthTokens({ accessToken, refreshToken });
  await saveAuthUser(user);
  saveAuthProvider('firebase');

  try {
    const { ensureFirestoreUserProfile } = await import('./firebaseClient.js');
    await ensureFirestoreUserProfile(user);
  } catch (err) {
    console.error('Firestore profile initialization failed:', err);
  }

  return user;
}

/**
 * End local access before best-effort revocation. Retained drafts and generated
 * turns stay in their owner-scoped session storage for that owner's next login.
 */
export async function logout() {
  const generation = ++sessionGeneration;
  const previousTokens = getAuthTokens();
  // Start detection while the old provider is still available, without waiting
  // for legacy IndexedDB probing before clearing the local session.
  const firebaseSession = typeof window !== 'undefined' ? usesFirebase() : Promise.resolve(false);
  // Both storage calls execute synchronously before their promises settle.
  // Do not yield between taking the snapshot and removing the old credentials.
  await clearAuth();
  const tokens = await previousTokens;
  if (tokens?.refreshToken) void revokeSession(tokens.refreshToken);
  void signOutPreviousFirebase(firebaseSession, generation);
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

async function signOutPreviousFirebase(firebaseSession, generation) {
  let timeout;
  let expired = false;
  try {
    const sdk = await Promise.race([
      firebaseSession.then(async wasFirebase => {
        if (!wasFirebase || expired || generation !== sessionGeneration) return null;
        return import('./firebaseAuth.js');
      }),
      new Promise(resolve => {
        timeout = setTimeout(() => { expired = true; resolve(null); }, LOGOUT_CLEANUP_TIMEOUT_MS);
      }),
    ]);
    if (!sdk) return;
    const currentTokens = await getAuthTokens();
    if (currentTokens || generation !== sessionGeneration) return;
    await sdk.signOutFirebase();
  } catch { /* Best effort; never clear credentials belonging to a new login. */ }
  finally { clearTimeout(timeout); }
}

/**
 * Check if the user is logged in (has stored tokens).
 */
export async function isLoggedIn() {
  const tokens = await getAuthTokens();
  return !!tokens?.accessToken;
}

/**
 * Get the current user object, or null if not logged in.
 */
export { getAuthUser as getCurrentUser } from './storage.js';

/**
 * Refresh the access token using the stored refresh token.
 * Returns true on success, false on failure (user must re-login).
 */
const sameSession = (left, right) => left?.user?.userId === right?.user?.userId
  && left?.accessToken === right?.accessToken && left?.refreshToken === right?.refreshToken;

async function refreshAccessToken(tokens, generation) {
  if (!tokens?.refreshToken) return false;
  if (!sameSession(tokens, await getAuthTokens()) || generation !== sessionGeneration) return false;
  try {
    const res = await fetch(`${SERVICE_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (!res.ok) {
      // Don't clear auth silently — the user's data should be preserved.
      // Notify listeners so the UI can prompt re-login.
      if (sameSession(tokens, await getAuthTokens()) && generation === sessionGeneration) _notifySessionExpired();
      return false;
    }
    const { accessToken, refreshToken } = await res.json();
    // Compare and replace synchronously inside storage, after all awaits.
    // A late response must never merge account A's tokens into account B.
    if (generation !== sessionGeneration) return false;
    return await saveAuthTokens({ accessToken, refreshToken }, tokens);
  } catch {
    return false;
  }
}

/**
 * Make an authenticated request to the plato server.
 * Automatically refreshes the access token on 401.
 */
export async function authenticatedFetch(path, options = {}) {
  const generation = sessionGeneration;
  const tokens = await getAuthTokens();
  if (!tokens?.accessToken) throw new Error('Not logged in');

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
      if (!current?.accessToken || ownerOf(current) !== owner || generation !== sessionGeneration) throw new Error('The signed-in account changed. Return to the original account.');
      const headers = new Headers(requestOptions.headers);
      headers.set('Authorization', `Bearer ${current.accessToken}`);
      requestTokens = current;
      return fetch(`${SERVICE_URL}${requestPath}`, { ...requestOptions, headers });
    };
    let response = await doFetch();
    if (response.status === 401) {
      const refreshed = await refreshAccessToken(requestTokens, generation);
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
  if (protectedPath) {
    const compatibility = await compatibilityHeaders(async () => {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const response = await fetchAsOwner('/v1/sync/status', { cache: 'no-store', signal });
      if (!response.ok) throw new Error('Could not check for updates. Keep this page open and try again.');
      return response.json();
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
  return { success: true };
}

/**
 * Update the authenticated user's profile (name, password, etc.).
 * Returns the updated user object.
 */
export async function updateProfile(updates) {
  const res = await authenticatedFetch('/v1/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Update failed');
  }
  const data = await res.json();
  await saveAuthUser(data);
  return data;
}

/**
 * Admin-defined custom user fields (#364): definitions, the caller's values,
 * and the ids of required fields still missing. Always fetched fresh — the
 * cached auth user can't know an admin just added a required field.
 */
export async function getMyFields() {
  const res = await authenticatedFetch('/v1/me/fields');
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
