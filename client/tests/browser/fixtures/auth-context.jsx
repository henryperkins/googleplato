import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from '../../../src/contexts/AuthContext.jsx';
import * as auth from '../../../js/auth.js';

function Observer() {
  const context = useAuth();
  useEffect(() => { window.authHarness = { ...context, auth }; });
  useEffect(() => { (window.publishedUsers ||= []).push(context.user?.name || null); }, [context.user]);
  return <output>{JSON.stringify({ name: context.user?.name, role: context.user?.role, loading: context.loading, impersonating: context.impersonatedUser?.userId })}</output>;
}
createRoot(document.getElementById('root')).render(<AuthProvider><Observer /></AuthProvider>);
