import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../contexts/AppContext.jsx';
import { routePageName, pageTitle } from '../lib/routeTitles.js';

export default function ScreenReaderAnnounce() {
  const location = useLocation();
  const { state } = useApp();
  const [message, setMessage] = useState('');

  // Resolve to primitives so a lessons refresh (tab refocus) with the same
  // names doesn't re-announce the page.
  const { name, pending } = routePageName(location.pathname, {
    lessons: state.lessons,
    lessonsLoaded: state.loaded,
  });

  useEffect(() => {
    if (pending) {
      document.title = pageTitle('Lesson');
      return;
    }
    if (name) {
      setMessage(`Navigated to ${name}`);
      document.title = pageTitle(name);
    }
  }, [location.pathname, name, pending]);

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
