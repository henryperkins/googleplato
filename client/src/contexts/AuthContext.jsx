import { createContext, useContext, useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { can } from '../lib/permissions.js';
import * as authModule from '../../js/auth.js';
import { authenticatedFetch } from '../../js/auth.js';
import { clearCache } from '../../js/storage.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [transitioning, setTransitioning] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Why the last session ended ('expired', or null for a deliberate sign-out),
  // so the sign-in page can explain an expiry. Cleared by the next sign-in.
  const [signedOutReason, setSignedOutReason] = useState(null);
  // "View as User" admin feature: when set, the SPA renders the classroom
  // as if this user were logged in (read-only). Persisted in sessionStorage
  // by auth.js so authenticatedFetch can attach `?asUserId=` to GETs.
  const [impersonatedUser, setImpersonatedUserState] = useState(null);

  const publication = useRef(0);
  const publicAuthSurfaces = useRef(new Set());
  const registerPublicAuthSurface = useCallback(() => {
    const surface = Symbol('public-auth');
    publicAuthSurfaces.current.add(surface);
    return () => publicAuthSurfaces.current.delete(surface);
  }, []);

  const publishUser = useCallback((u) => {
    setUser(u);
    if (!can(u, 'impersonation.use') && authModule.getImpersonation()) {
      authModule.setImpersonation(null);
      clearCache();
      setImpersonatedUserState(null);
      // AppContext can still hold the target's in-memory lesson data. Use the
      // same clean boundary as leaving View as User explicitly.
      if (typeof location !== 'undefined') location.assign('/lessons');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ticket = publication.current;
    const generation = authModule.getSessionGeneration();
    const valid = () => !cancelled && ticket === publication.current && generation === authModule.getSessionGeneration();
    (async () => {
      const result = await authModule.isLoggedIn();
      if (!valid()) return;
      if (result) {
        const session = await authModule.captureAuthSession();
        const u = await authModule.getCurrentUser();
        if (!valid() || u?.userId !== session?.userId || !await authModule.isAuthSessionCurrent(session) || !valid()) return;
        setLoggedIn(true);
        publishUser(u);
        const stashed = authModule.getImpersonation();
        if (stashed && can(u, 'impersonation.use')) setImpersonatedUserState(stashed);
        authModule.refreshCurrentUser().then(async fresh => {
          if (fresh && valid() && await authModule.isAuthSessionCurrent(session) && valid()) publishUser(fresh);
        });
      }
      if (valid()) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [publishUser]);

  useEffect(() => authModule.onAuthChange(identity => {
    publication.current += 1;
    clearCache();
    authModule.setImpersonation(null);
    // Keep a pending public exchange alive so its stale response can revoke its
    // unused token and explain the conflict. Classroom state must be destroyed.
    const publicAuth = publicAuthSurfaces.current.size > 0;
    flushSync(() => {
      setLoggedIn(false);
      setUser(null);
      setLoading(false);
      setSessionExpired(false);
      setImpersonatedUserState(null);
      if (!publicAuth) setTransitioning(true);
    });
    if (!publicAuth) location.assign(identity ? '/lessons' : '/login');
  }), []);

  // Listen for session expiry (e.g. refresh token rotated by another device)
  useEffect(() => {
    return authModule.onSessionExpired(() => setSessionExpired(true));
  }, []);

  const login = useCallback(async (email, password, attemptId) => {
    const ticket = ++publication.current;
    const authUser = await authModule.login(email, password, attemptId);
    if (ticket !== publication.current) return authUser;
    setLoading(false);
    setLoggedIn(true);
    setUser(authUser);
    setSessionExpired(false);
    setSignedOutReason(null);
    return authUser;
  }, []);

  const adoptExternalSession = useCallback(async (session, provider, attemptId) => {
    const ticket = ++publication.current;
    const authUser = await authModule.adoptAuthSession(session, provider, attemptId);
    if (ticket !== publication.current) return authUser;
    setLoading(false);
    setLoggedIn(true);
    setUser(authUser);
    setSessionExpired(false);
    setSignedOutReason(null);
    return authUser;
  }, []);

  const refreshUser = useCallback(async () => {
    const ticket = publication.current;
    const session = await authModule.captureAuthSession();
    const u = await authModule.getCurrentUser();
    if (ticket === publication.current && await authModule.isAuthSessionCurrent(session)
      && session.generation === authModule.getSessionGeneration()) publishUser(u);
  }, [publishUser]);

  const logout = useCallback(async ({ reason = null } = {}) => {
    publication.current += 1;
    setLoading(false);
    // Always exit impersonation before logging out so the next session
    // doesn't inherit a stale view.
    if (authModule.getImpersonation()) {
      authModule.setImpersonation(null);
      clearCache();
    }
    setImpersonatedUserState(null);
    setLoggedIn(false);
    setUser(null);
    setSessionExpired(false);
    setSignedOutReason(reason);
    await authModule.logout();
  }, []);

  const startImpersonation = useCallback(async (targetUserId) => {
    const session = await authModule.captureAuthSession();
    if (!session) throw new Error('Not logged in');
    const res = await authenticatedFetch('/v1/admin/impersonation/start', {
      expectedUserId: session.userId,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to start impersonation');
    }
    const target = await res.json();
    if (!await authModule.isAuthSessionCurrent(session) || session.generation !== authModule.getSessionGeneration()) {
      throw new Error('The signed-in account changed. Return to the original account.');
    }
    authModule.setImpersonation(target);
    clearCache(); // admins sync-data must not leak into the targets view
    setImpersonatedUserState(target);
    // Hard reload to /lessons. clearCache() handles the storage layer, but
    // AppContext (lesson list, lesson KB summaries on cards) and any other
    // component-level state would still hold the admins data otherwise.
    // For an audit/security feature, "no stale data" is more important than
    // a faster transition.
    if (typeof location !== 'undefined') location.assign('/lessons');
    return target;
  }, []);

  const stopImpersonation = useCallback(async () => {
    const current = authModule.getImpersonation();
    authModule.setImpersonation(null);
    clearCache(); // targets data must not linger after exit
    setImpersonatedUserState(null);
    // Best-effort end notification — fire-and-forget so the reload below
    // doesnt have to wait on it.
    if (current?.userId) {
      authenticatedFetch('/v1/admin/impersonation/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: current.userId }),
      }).catch(() => { /* audit-log is best-effort; the start entry is the source of truth */ });
    }
    // Same hard-reload reasoning as startImpersonation — AppContext etc.
    // would otherwise still hold the targets state.
    if (typeof location !== 'undefined') location.assign('/lessons');
  }, []);

  return (
    <AuthContext.Provider value={{
      loggedIn, user, loading, login, adoptExternalSession, logout, refreshUser, sessionExpired, signedOutReason,
      impersonatedUser, startImpersonation, stopImpersonation, registerPublicAuthSurface,
    }}>
      {transitioning ? null : children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Setup can own any URL during first-run bootstrap. Register the mounted
// surface rather than inferring it from a route or saved authentication state.
export function usePublicAuthSurface(enabled = true) {
  const { registerPublicAuthSurface } = useAuth();
  useLayoutEffect(() => enabled ? registerPublicAuthSurface() : undefined,
    [enabled, registerPublicAuthSurface]);
}
