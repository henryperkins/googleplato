// Order and grouping for the learner's lesson list. Pure, so it's unit-tested
// (client/tests/lessonListOrder.test.js).
import { groupByCourse } from './courseCompletion.js';

/** Started and not yet completed, from the lesson's `lessonKB` status. */
export function isInProgress(progress) {
  return Boolean(progress?.status) && progress.status !== 'completed';
}

const compareNames = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function catalogOrder(a, b) {
  const courseA = a.course?.name || '';
  const courseB = b.course?.name || '';
  // Lessons without a course go last.
  if (!courseA && courseB) return 1;
  if (courseA && !courseB) return -1;
  return compareNames(courseA, courseB) || compareNames(a.name, b.name);
}

/**
 * Catalog order: course name A–Z (lessons without a course last), then lesson
 * name. With `inProgressFirst`, the lessons the learner has started and not
 * completed lead the whole list, still in catalog order among themselves, so
 * a long course or pagination can't push them off the first page.
 */
export function orderLessons(lessons, lessonData = {}, { inProgressFirst = false } = {}) {
  const catalog = lessons.slice().sort(catalogOrder);
  if (!inProgressFirst) return catalog;
  const started = catalog.filter((lesson) => isInProgress(lessonData[lesson.lessonId]));
  if (started.length === 0) return catalog;
  return [...started, ...catalog.filter((lesson) => !isInProgress(lessonData[lesson.lessonId]))];
}

/**
 * Groups for one page of the ordered list, in reading order: the lessons in
 * progress (with `inProgressFirst`), then one group per course in first-seen
 * order, then lessons without a course. `kind` is 'in-progress', 'course' or
 * 'other'.
 */
export function groupLessonsForPage(pageLessons, lessonData = {}, { inProgressFirst = false } = {}) {
  const started = inProgressFirst ? pageLessons.filter((lesson) => isInProgress(lessonData[lesson.lessonId])) : [];
  const rest = started.length ? pageLessons.filter((lesson) => !started.includes(lesson)) : pageLessons;
  const groups = groupByCourse(rest).map((group) => ({
    ...group,
    kind: group.courseId ? 'course' : 'other',
    key: group.courseId ? `course:${group.courseId}` : 'other',
  }));
  if (!started.length) return groups;
  return [{ kind: 'in-progress', key: 'in-progress', courseId: null, courseName: null, lessons: started }, ...groups];
}

/**
 * Whether lessons without a course need their own heading: only when the
 * ordered list also has a course group or an in-progress group, on any page.
 * A list of only course-less lessons needs no heading.
 */
export function needsOtherHeading(orderedLessons, lessonData = {}, { inProgressFirst = false } = {}) {
  return orderedLessons.some((lesson) => Boolean(lesson.course?.id)
    || (inProgressFirst && isInProgress(lessonData[lesson.lessonId])));
}

/**
 * The lesson marked **Start here** for a learner who hasn't started any
 * lesson: the first in the ordered list, so a course filter suggests that
 * course's first lesson. Null once any lesson has a status, and for a list of
 * one, where there's nothing to choose between. An admin's own `custom-`
 * lessons are never the suggestion.
 */
export function startHereLessonId(orderedLessons, allLessons, lessonData = {}) {
  if (orderedLessons.length < 2) return null;
  if (allLessons.some((lesson) => lessonData[lesson.lessonId]?.status)) return null;
  return orderedLessons.find((lesson) => !lesson.lessonId.startsWith('custom-'))?.lessonId ?? null;
}
