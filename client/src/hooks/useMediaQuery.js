import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** Whether `query` matches now, re-rendering when that changes (a resize or rotation). */
export default function useMediaQuery(query) {
  // One MediaQueryList per query; its `matches` is live, so each read is cheap.
  const list = useMemo(() => (typeof window === 'undefined' ? null : window.matchMedia(query)), [query]);
  const subscribe = useCallback((onChange) => {
    if (!list) return () => {};
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [list]);
  return useSyncExternalStore(subscribe, () => !!list?.matches, () => false);
}
