import { authenticatedFetch } from '../../js/auth.js';
import { getCachedLessonKB } from '../../js/storage.js';

export function toLessonStatus(kb) {
  return { status: kb?.status || null, progress: kb?.progress ?? null };
}

// A complete bulk sync proves that an absent record is unstarted. Without
// that proof, only explicitly cached records (including null) are known.
export function cachedLessonStatuses(lessons, { complete = false } = {}) {
  const statuses = {};
  for (const { lessonId } of lessons) {
    const kb = getCachedLessonKB(lessonId);
    if (kb === undefined && !complete) return null;
    statuses[lessonId] = toLessonStatus(kb);
  }
  return statuses;
}

// Fallback when bulk sync did not establish a complete progress snapshot.
// Read failures must not become "not started". Keep these reads out of the
// shared cache so a superseded response cannot replace a newer bulk sync.
export async function loadLessonStatuses(lessons, { signal } = {}) {
  const statuses = {};
  for (const { lessonId } of lessons) {
    signal?.throwIfAborted();
    const dataKey = `lessonKB:${lessonId}`;
    const response = await authenticatedFetch(`/v1/sync/${encodeURIComponent(dataKey)}`, { signal });
    signal?.throwIfAborted();
    if (!response.ok) throw new Error('Lesson progress could not be loaded.');
    const item = await response.json();
    signal?.throwIfAborted();
    if (!item || item.dataKey !== dataKey || !Object.hasOwn(item, 'data')
      || (item.data !== null && (typeof item.data !== 'object' || Array.isArray(item.data)))) {
      throw new Error('Lesson progress response is incomplete.');
    }
    statuses[lessonId] = toLessonStatus(item.data);
  }
  return statuses;
}
