import { lazy, Suspense, useState, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext.jsx';
import AppShell from './components/AppShell.jsx';
import LessonsList from './pages/LessonsList.jsx';
import LessonChat from './pages/LessonChat.jsx';
import Login from './pages/Login.jsx';
import ScreenReaderAnnounce from './components/ScreenReaderAnnounce.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { loadPublicBranding } from './lib/publicBranding.js';
import { returnPath } from './lib/returnPath.js';
import ProfileCompletionGate from './components/ProfileCompletionGate.jsx';
import { BrandingProvider } from './contexts/BrandingContext.jsx';

const AdminLayout = lazy(() => import('./pages/admin/AdminLayout.jsx'));
const AdminHome = lazy(() => import('./pages/admin/AdminHome.jsx'));
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers.jsx'));
const AdminLessons = lazy(() => import('./pages/admin/AdminLessons.jsx'));
const AdminCustomizer = lazy(() => import('./pages/admin/AdminCustomizer.jsx'));
const AdminAI = lazy(() => import('./pages/admin/AdminAI.jsx'));
const AdminPlugins = lazy(() => import('./pages/admin/AdminPlugins.jsx'));
const AdminKBSetup = lazy(() => import('./pages/admin/AdminKBSetup.jsx'));

// Login, the lesson list, and the lesson conversation are the core path and
// ship in the entry bundle. Less-visited pages load on demand, so a learner's
// first load doesn't carry signup, setup, or settings code (and vice versa).
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Signup = lazy(() => import('./pages/Signup.jsx'));
const Waitlist = lazy(() => import('./pages/Waitlist.jsx'));
const Privacy = lazy(() => import('./pages/Privacy.jsx'));
const Setup = lazy(() => import('./pages/Setup.jsx'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'));
const ResetPassword = lazy(() => import('./pages/ResetPassword.jsx'));

function RequireAuth({ children }) {
  const { loggedIn, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <main className="min-h-dvh flex items-center justify-center" role="status" aria-live="polite">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" aria-hidden="true" />
        <span className="sr-only">Loading...</span>
      </main>
    );
  }
  // Signing in brings the learner back here (returnPath), e.g. after a session
  // expires mid-lesson.
  if (!loggedIn) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return children;
}

function RequireAdmin({ children }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/lessons" replace />;
  return children;
}

function RequireGuest({ children }) {
  const { loggedIn, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (loggedIn) return <Navigate to={returnPath(location.state?.from)} replace />;
  return children;
}

const PageFallback = () => (
  <main className="min-h-dvh flex items-center justify-center" role="status" aria-live="polite">
    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" aria-hidden="true" />
    <span className="sr-only">Loading...</span>
  </main>
);

// Inside the classroom shell, which already provides <main>.
const ContentFallback = () => (
  <div className="flex items-center justify-center py-12" role="status" aria-live="polite">
    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" aria-hidden="true" />
    <span className="sr-only">Loading...</span>
  </div>
);

export default function App() {
  const { loading } = useAuth();
  const location = useLocation();
  const [needsSetup, setNeedsSetup] = useState(null);

  useEffect(() => {
    // Branding loads in parallel with the setup check, so pages render with
    // their classroom colors instead of waiting for a request of their own.
    loadPublicBranding();
    fetch('/v1/auth/setup-status')
      .then(r => r.json())
      .then(d => setNeedsSetup(d.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  if (loading || needsSetup === null) {
    return (
      <main className="min-h-dvh flex items-center justify-center" role="status" aria-live="polite">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" aria-hidden="true" />
        <span className="sr-only">Loading...</span>
      </main>
    );
  }

  if (needsSetup) {
    return (
      <>
        <ScreenReaderAnnounce />
        <ErrorBoundary resetKey={location.pathname}>
          <Routes>
            <Route path="*" element={<Suspense fallback={<PageFallback />}><Setup /></Suspense>} />
          </Routes>
        </ErrorBoundary>
      </>
    );
  }

  return (
    <>
      <ScreenReaderAnnounce />
      <ErrorBoundary resetKey={location.pathname}>
      <Routes>
        <Route path="/login" element={<RequireGuest><Login /></RequireGuest>} />
        <Route path="/signup" element={<RequireGuest><Suspense fallback={<PageFallback />}><Signup /></Suspense></RequireGuest>} />
        <Route path="/waitlist" element={<RequireGuest><Suspense fallback={<PageFallback />}><Waitlist /></Suspense></RequireGuest>} />
        <Route path="/forgot-password" element={<RequireGuest><Suspense fallback={<PageFallback />}><ForgotPassword /></Suspense></RequireGuest>} />
        <Route path="/reset-password" element={<RequireGuest><Suspense fallback={<PageFallback />}><ResetPassword /></Suspense></RequireGuest>} />
        <Route path="/privacy" element={<Suspense fallback={<PageFallback />}><Privacy /></Suspense>} />

        <Route path="/plato/*" element={
          <RequireAuth>
            <RequireAdmin>
              <Suspense fallback={<PageFallback />}>
                <AdminLayout />
              </Suspense>
            </RequireAdmin>
          </RequireAuth>
        }>
          <Route index element={<Suspense fallback={<PageFallback />}><AdminHome /></Suspense>} />
          <Route path="users" element={<Suspense fallback={<PageFallback />}><AdminUsers /></Suspense>} />
          <Route path="users/:userId" element={<Suspense fallback={<PageFallback />}><AdminUsers /></Suspense>} />
          <Route path="users/waitlist/:waitlistToken" element={<Suspense fallback={<PageFallback />}><AdminUsers /></Suspense>} />
          <Route path="lessons" element={<Suspense fallback={<PageFallback />}><AdminLessons /></Suspense>} />
          <Route path="lessons/new" element={<Suspense fallback={<PageFallback />}><AdminLessons /></Suspense>} />
          <Route path="lessons/:lessonId/edit" element={<Suspense fallback={<PageFallback />}><AdminLessons /></Suspense>} />
          {/* Course management lives inside Admin → Lessons (a "Courses" button
              opens a modal). Keep this route as a redirect for any bookmarked
              link from the prior standalone-page iteration. */}
          <Route path="courses" element={<Navigate to="/plato/lessons" replace />} />
          <Route path="customizer" element={<Suspense fallback={<PageFallback />}><AdminCustomizer /></Suspense>} />
          <Route path="ai" element={<Suspense fallback={<PageFallback />}><AdminAI /></Suspense>} />
          <Route path="customizer/knowledge" element={<Suspense fallback={<PageFallback />}><AdminCustomizer /></Suspense>} />
          <Route path="customizer/knowledge/edit" element={<Suspense fallback={<PageFallback />}><AdminCustomizer /></Suspense>} />
          <Route path="plugins" element={<Suspense fallback={<PageFallback />}><AdminPlugins /></Suspense>} />
          {/* Back-compat redirect from the old /plato/integrations URL */}
          <Route path="integrations" element={<Navigate to="/plato/plugins" replace />} />
          <Route path="setup-kb" element={<Suspense fallback={<PageFallback />}><AdminKBSetup /></Suspense>} />
          <Route path="*" element={<Navigate to="/plato" replace />} />
        </Route>

        {/* Classroom routes — custom theme/branding applied here */}
        <Route path="/*" element={
          <RequireAuth>
            <BrandingProvider>
            <AppShell>
              {/* Required custom user fields (#364) must be filled before the classroom renders. */}
              <ProfileCompletionGate>
              <Routes>
                <Route path="/lessons" element={<LessonsList />} />
                <Route path="/lessons/create" element={<Navigate to="/lessons" replace />} />
                <Route path="/lessons/:lessonGroupId" element={<LessonChat />} />
                <Route path="/settings" element={<Suspense fallback={<ContentFallback />}><Settings /></Suspense>} />
                <Route path="/" element={<Navigate to="/lessons" replace />} />
                <Route path="*" element={<Navigate to="/lessons" replace />} />
              </Routes>
              </ProfileCompletionGate>
            </AppShell>
            </BrandingProvider>
          </RequireAuth>
        } />
      </Routes>
      </ErrorBoundary>
    </>
  );
}
