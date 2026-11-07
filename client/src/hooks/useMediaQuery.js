import { useCallback, useSyncExternalStore } from 'react';

/** Whether `query` matches now, re-rendering when that changes (a resize or rotation). */
export default function useMediaQuery(query) {
  const subscribe = useCallback((onChange) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
