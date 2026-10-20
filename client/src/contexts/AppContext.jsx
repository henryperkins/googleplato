import { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import { getPreferences } from '../../js/storage.js';
import { loadLessons, invalidateLessonsCache } from '../../js/lessonOwner.js';
import * as sync from '../../js/sync.js';
import { useAuth } from './AuthContext.jsx';

const AppContext = createContext(null);

const initialState = {
  lessons: [],
  preferences: { name: '' },
  generating: null,
  loaded: false,
  loadingLessons: false,
  lessonsError: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'INIT_DATA':
      return { ...state, ...action.payload, loaded: true, loadingLessons: false, lessonsError: null };
    case 'LOADING_LESSONS':
      return { ...state, loadingLessons: true };
    case 'LESSONS_LOAD_FAILED':
      return { ...state, loaded: true, loadingLessons: false, lessonsError: 'We couldn’t load your lessons. Check your connection and try again.' };
    case 'SET_PREFERENCES':
      return { ...state, preferences: action.preferences };
    case 'SET_GENERATING':
      return { ...state, generating: action.generating };
    case 'REFRESH_LESSONS':
      return { ...state, lessons: action.lessons };
    default:
      return state;
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { loggedIn } = useAuth();
  const requestIdRef = useRef(0);

  const reloadLessons = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const isCurrent = () => requestId === requestIdRef.current;
    invalidateLessonsCache();
    dispatch({ type: 'LOADING_LESSONS' });
    try {
      try { await sync.loadAll({ isCurrent }); } catch { /* offline or error */ }
      if (!isCurrent()) return;
      const [lessons, preferences] = await Promise.all([loadLessons(), getPreferences()]);
      if (isCurrent()) {
        dispatch({ type: 'INIT_DATA', payload: { preferences, lessons } });
      }
    } catch {
      if (isCurrent()) dispatch({ type: 'LESSONS_LOAD_FAILED' });
    }
  }, []);

  // Initial load, manual retry, and foreground refresh share the same recovery
  // path. Failed refreshes keep the last rendered lessons available.
  useEffect(() => {
    if (!loggedIn) return;
    reloadLessons();
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      reloadLessons();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      requestIdRef.current += 1;
      invalidateLessonsCache();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loggedIn, reloadLessons]);

  return (
    <AppContext.Provider value={{ state, dispatch, reloadLessons }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
