import { useEffect, useMemo, useState } from 'react';
import { getCachedLessonKB } from '../../js/storage.js';
import { cachedLessonStatuses, loadLessonStatuses, toLessonStatus } from '../lib/lessonListProgress.js';

// Publish a catalog and its progress together. A failed refresh keeps the
// previous verified list usable while the new snapshot is loading or retried.
export function useLessonListProgress(sourceLessons, { loaded, hydrated }) {
  const [resolved, setResolved] = useState(null);
  const [failure, setFailure] = useState(null);
  const cachedSnapshot = useMemo(() => {
    // A completed failed request does not verify the initial empty catalog.
    if (!loaded) return null;
    const statuses = cachedLessonStatuses(sourceLessons, { complete: hydrated });
    return statuses ? { lessons: sourceLessons, statuses } : null;
  }, [sourceLessons, loaded, hydrated]);

  // Local event updates belong only to the catalog that produced them. A new
  // bulk snapshot takes precedence over all statuses from an older catalog.
  const snapshot = (resolved?.lessons === sourceLessons ? resolved : cachedSnapshot) || resolved;

  useEffect(() => {
    if (!loaded) return;
    const controller = new AbortController();
    const { signal } = controller;
    const completions = {};
    const pending = cachedSnapshot
      ? Promise.resolve(cachedSnapshot.statuses)
      : loadLessonStatuses(sourceLessons, { signal });
    pending.then(statuses => {
      if (signal.aborted) return;
      setResolved({ lessons: sourceLessons, statuses: { ...statuses, ...completions } });
      setFailure(null);
    }).catch(() => {
      if (!signal.aborted) setFailure({ lessons: sourceLessons,
        message: 'We couldn’t load your lesson progress. Check your connection and try again.' });
    });

    const handleCompletion = async event => {
      const lessonId = event.detail?.lessonId;
      if (!sourceLessons.some(lesson => lesson.lessonId === lessonId)) return;
      try {
        const kb = getCachedLessonKB(lessonId);
        const status = kb !== undefined ? toLessonStatus(kb)
          : (await loadLessonStatuses([{ lessonId }], { signal }))[lessonId];
        if (signal.aborted) return;
        completions[lessonId] = status;
        setResolved(previous => {
          const current = previous?.lessons === sourceLessons ? previous : cachedSnapshot;
          return current ? { ...current, statuses: { ...current.statuses, ...completions } } : previous;
        });
      } catch { /* Retain the verified status if a completion read fails. */ }
    };
    window.addEventListener('plato:lesson-completed', handleCompletion);
    return () => {
      controller.abort();
      window.removeEventListener('plato:lesson-completed', handleCompletion);
    };
  }, [sourceLessons, loaded, cachedSnapshot]);

  return {
    lessons: snapshot?.lessons || [],
    statuses: snapshot?.statuses || {},
    ready: Boolean(snapshot),
    error: failure?.lessons === sourceLessons ? failure.message : null,
  };
}
