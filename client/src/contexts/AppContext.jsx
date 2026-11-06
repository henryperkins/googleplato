import { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import { getPreferences } from '../../js/storage.js';
import { loadLessons, invalidateLessonsCache } from '../../js/lessonOwner.js';
import * as sync from '../../js/sync.js';
import { useAuth } from './AuthContext.jsx';

const AppContext = createContext(null);

const initialState = {
  lessons: [],
  preferences: { name: '' },
  preferencesLoaded: false,
  generating: null,
  loaded: false,
  lessonCatalogLoaded: false,
  loadingLessons: false,
  lessonsError: null,
  lessonProgressHydrated: false,
};

function reducer(state, action) {
  switch (action.type) {
    case 'RESET_DATA':
      return initialState;
    case 'INIT_DATA':
      return { ...state, ...action.payload, loaded: true, preferencesLoaded: true, lessonCatalogLoaded: true, loadingLessons: false, lessonsError: null };
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
  const { loggedIn, user } = useAuth();
  const ownerId = user?.userId;
  const requestIdRef = useRef(0);

  const reloadLessons = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const isCurrent = () => requestId === requestIdRef.current;
    invalidateLessonsCache();
    dispatch({ type: 'LOADING_LESSONS' });
    try {
      let lessonProgressHydrated = false;
      try { lessonProgressHydrated = await sync.loadAll({ isCurrent }); } catch { /* offline or error */ }
      if (!isCurrent()) return;
      const [lessons, preferences] = await Promise.all([loadLessons(), getPreferences({ expectedUserId: ownerId })]);
      if (isCurrent()) {
        dispatch({ type: 'INIT_DATA', payload: { preferences, lessons, lessonProgressHydrated } });
      }
    } catch {
      if (isCurrent()) dispatch({ type: 'LESSONS_LOAD_FAILED' });
    }
  }, [ownerId]);

  // Initial load, manual retry, and foreground refresh share the same recovery
  // path. Failed refreshes keep the last rendered lessons available.
  useEffect(() => {
    if (!loggedIn) {
      dispatch({ type: 'RESET_DATA' });
      return;
    }
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
