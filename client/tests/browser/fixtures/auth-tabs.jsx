import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth, usePublicAuthSurface } from '../../../src/contexts/AuthContext.jsx';
import { createPublicAuthSessionGuard } from '../../../src/lib/plugins/PublicAuthProviders.jsx';
import * as auth from '../../../js/auth.js';
import * as storage from '../../../js/storage.js';

const classroom = new URLSearchParams(location.search).has('classroom');
history.replaceState(null, '', classroom ? '/lessons/draft' : '/login');
window.core = { auth, storage };
window.events = [];
window.addEventListener('storage', event => window.events.push(event.key));
window.publishedUsers = [];
function Observer() {
  usePublicAuthSurface(!classroom);
  const context = useAuth();
  useEffect(() => { window.authHarness = { ...context, auth, storage, createPublicAuthSessionGuard }; });
  useEffect(() => { window.publishedUsers.push(context.user?.name || null); }, [context.user]);
  useEffect(() => () => {
    window.unmounted = true;
    window.cacheAtUnmount = storage.getCachedLessonKB('draft');
    // A real stale component cleanup attempting an unscoped save must fail.
    window.cleanupWrite = storage.saveLessonKB('draft', { draft: 'Account X unsaved work' });
    window.cleanupWrite.finally(() => window.reportTeardown?.({ cache: window.cacheAtUnmount }));
  }, []);
  return <output>{context.user?.name || 'Signed out'}</output>;
}
createRoot(document.getElementById('root')).render(<AuthProvider><Observer /></AuthProvider>);
