// Course completion counts for the learner's lesson list (#395). Pure so it's
// unit-tested (client/tests/courseCompletion.test.js).

/**
 * `{ [courseId]: { completed, total } }` over ALL of the learner's public lessons —
 * not the filtered/paginated view, so a status filter like "Not started"
 * can't turn "5 of 8" into "0 of 3". The server normalizes legacy visibility;
 * private shared lessons and missing/unknown visibility never count. Custom
 * (`custom-*`) lessons and lessons without a course aren't counted either.
 */
export function courseCompletion(lessons, lessonData) {
  const byCourse = {};
  for (const lesson of lessons) {
    const courseId = lesson.course?.id;
    if (!courseId || lesson.status !== 'public' || lesson.lessonId.startsWith('custom-')) continue;
    const c = (byCourse[courseId] ||= { completed: 0, total: 0 });
    c.total++;
    if (lessonData[lesson.lessonId]?.status === 'completed') c.completed++;
  }
  return byCourse;
}

/**
 * Group the current page by course id, preserving first-seen course order.
 * Distinct courses with equally sorted names can have interleaved lessons.
 */
export function groupByCourse(lessons) {
  const groups = new Map();
  for (const lesson of lessons) {
    const courseId = lesson.course?.id || null;
    if (!groups.has(courseId)) {
      groups.set(courseId, { courseId, courseName: lesson.course?.name || null, lessons: [] });
    }
    groups.get(courseId).lessons.push(lesson);
  }
  return [...groups.values()];
}
