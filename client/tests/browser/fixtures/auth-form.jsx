import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from '../../../src/contexts/AuthContext.jsx';
import Signup from '../../../src/pages/Signup.jsx';
import Setup from '../../../src/pages/Setup.jsx';

const setup = new URLSearchParams(location.search).has('setup');
const path = setup ? '/setup' : '/signup?token=invited';
history.replaceState(null, '', path);
function Observer() {
  const context = useAuth();
  useEffect(() => { window.authHarness = context; });
  return setup ? <Setup /> : <Signup />;
}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[path]}><AuthProvider><Observer /></AuthProvider></MemoryRouter>);
