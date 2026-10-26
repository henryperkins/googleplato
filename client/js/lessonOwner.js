import { parseLessonPrompt } from '../../server/src/shared/lessonMarkdown.js';
/**
 * Lesson Owner — loads lesson prompts from markdown files
 * and parses their structure.
 */

import { authenticatedFetch } from './auth.js';
import { getUserLessons } from './storage.js';

let lessonsCache = null;
let cacheRevision = 0;

/**
 * Load all lessons from the server.
 * Returns parsed lessons with course metadata and normalized visibility status.
 */
export async function loadLessons() {
  if (lessonsCache) return lessonsCache;
  const revision = cacheRevision;

  const lessons = [];
  const resp = await authenticatedFetch('/v1/lessons');
  if (!resp.ok) throw new Error('Lessons could not be loaded.');
  const serverLessons = await resp.json();
  if (!Array.isArray(serverLessons)) throw new Error('Lessons could not be loaded.');
  for (const lesson of serverLessons) {
    if (lesson.markdown) {
      // Preserve server-normalized visibility for public-only course counts.
      const parsed = parseLessonPrompt(lesson.lessonId, lesson.markdown);
      if (lesson.course) parsed.course = lesson.course;
      parsed.status = lesson.status;
      lessons.push(parsed);
    }
  }

  // Merge user-created lessons from sync-data
  try {
    const userLessons = await getUserLessons();
    for (const uc of userLessons) {
      if (uc.markdown && !lessons.some(c => c.lessonId === uc.lessonId)) {
        lessons.push(parseLessonPrompt(uc.lessonId, uc.markdown));
      }
    }
  } catch { /* ignore */ }

  lessons.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  // A request started before a refresh must not replace the refreshed cache.
  if (revision === cacheRevision) lessonsCache = lessons;
  return lessons;
}

/** Clear the cache so loadLessons() re-fetches on next call. */
export function invalidateLessonsCache() {
  lessonsCache = null;
  cacheRevision += 1;
}

/**
 * Return the lessons belonging to a course as `[{ name, description }]`.
 * Used to give the course-progress agent the course's shape for naming and
 * framing. Empty array when the course is empty, unknown, or unavailable;
 * this optional context must not prevent recording a completed lesson.
 */
export async function getLessonsInCourse(courseId) {
  if (!courseId) return [];
  const lessons = await loadLessons().catch(() => []);
  return lessons
    .filter(l => l.course?.id === courseId)
    .map(l => ({ name: l.name, description: l.description }));
}

/**
 * Parse a lesson prompt markdown file into structured data.
 */
export { parseLessonPrompt } from '../../server/src/shared/lessonMarkdown.js';
