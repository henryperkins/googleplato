import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { AppProvider } from './contexts/AppContext.jsx';
import { ModalProvider } from './contexts/ModalContext.jsx';
import App from './App.jsx';
import './index.css';

// A data router supplies the navigation blocker for unsaved Styles edits,
// including browser Back/Forward. The existing route tree stays in App.
const router = createBrowserRouter([{
  path: '*',
  element: (
    <AuthProvider>
      <AppProvider>
        <ModalProvider>
          <App />
        </ModalProvider>
      </AppProvider>
    </AuthProvider>
  ),
}]);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
