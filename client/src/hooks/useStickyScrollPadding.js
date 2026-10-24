import { useCallback, useEffect, useRef } from 'react';

const HEIGHT_VARS = { top: '--sticky-top', bottom: '--sticky-bottom' };

/**
 * Keep keyboard focus clear of a page's sticky header and footer (WCAG 2.4.11).
 * index.css sets html's scroll padding from these heights, so an element
 * scrolled into view stops below the header and above the footer however tall
 * they grow: a three-line title, enlarged text, attachments in the composer.
 * Returns callback refs for the two bars; either may mount later, or never.
 */
export function useStickyScrollPadding() {
  const elements = useRef({ top: null, bottom: null });
  const observer = useRef(null);

  const measure = useCallback(() => {
    const root = document.documentElement;
    for (const [edge, name] of Object.entries(HEIGHT_VARS)) {
      const el = elements.current[edge];
      if (el) root.style.setProperty(name, `${el.offsetHeight}px`);
      else root.style.removeProperty(name);
    }
  }, []);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    observer.current = new ResizeObserver(measure);
    for (const el of Object.values(elements.current)) if (el) observer.current.observe(el);
    measure();
    return () => {
      observer.current.disconnect();
      observer.current = null;
      for (const name of Object.values(HEIGHT_VARS)) document.documentElement.style.removeProperty(name);
    };
  }, [measure]);

  // Refs attach before effects run, so the first elements are observed once
  // the effect creates the observer; later ones (the composer) as they mount.
  const track = useCallback((edge, el) => {
    const previous = elements.current[edge];
    if (previous === el) return;
    if (previous) observer.current?.unobserve(previous);
    elements.current[edge] = el;
    if (el) observer.current?.observe(el);
    if (observer.current) measure();
  }, [measure]);

  const topRef = useCallback((el) => track('top', el), [track]);
  const bottomRef = useCallback((el) => track('bottom', el), [track]);
  return [topRef, bottomRef];
}
