import { useCallback } from 'react';

export function useAutoResize(maxHeight = 200) {
  return useCallback((e) => {
    const el = e.target;
    el.style.overflowY = 'hidden';
    el.style.height = 'auto';
    const minHeight = Number.parseFloat(getComputedStyle(el).minHeight) || 0;
    const newHeight = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight));
    el.style.height = newHeight + 'px';
    el.style.overflowY = newHeight >= maxHeight ? 'auto' : 'hidden';
  }, [maxHeight]);
}
