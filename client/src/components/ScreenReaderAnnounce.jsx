import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../contexts/AppContext.jsx';
import { routePageName, adminPageName, pageTitle } from '../lib/routeTitles.js';
import { cachedPublicBranding, loadPublicBranding, subscribePublicBranding } from '../lib/publicBranding.js';

export default function ScreenReaderAnnounce() {
  const location = useLocation();
  const { state } = useApp();
  const [message, setMessage] = useState('');
  const [classroomName, setClassroomName] = useState(() => cachedPublicBranding()?.classroomName || '');

  useEffect(() => {
    let cancelled = false;
    const sync = (branding) => {
      if (!cancelled) setClassroomName(branding?.classroomName || '');
    };
    const unsubscribe = subscribePublicBranding(sync);
    loadPublicBranding().then(sync);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [location.pathname]);

  // Resolve to primitives so a lessons refresh (tab refocus) with the same
  // names doesn't re-announce the page.
  const { name, pending } = routePageName(location.pathname, {
    lessons: state.lessons,
    lessonsLoaded: state.loaded,
  });
  const adminName = adminPageName(location.pathname);

  useEffect(() => {
    if (adminName) {
      setMessage(`Navigated to ${adminName}`);
    } else if (!pending && name) {
      setMessage(`Navigated to ${name}`);
    }
  }, [location.pathname, name, pending, adminName]);

  // Admin titles keep plato's name, not the classroom's, and change only with
  // the page: a page that names a view inside it (Edit User) sets its own
  // title after this one, and this must not overwrite it later.
  useEffect(() => {
    if (adminName) document.title = pageTitle(adminName);
  }, [adminName]);

  useEffect(() => {
    if (pending) {
      document.title = pageTitle('Lesson', classroomName);
      return;
    }
    if (name) {
      document.title = pageTitle(name, classroomName);
    }
  }, [location.pathname, name, pending, classroomName]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {message}
    </div>
  );
}
