export const LESSON_CARD_EXIT_MS = 160;
export const LESSON_CARD_STAGGER_LIMIT = 8;

/**
 * Reconciles the currently rendered lesson cards with the next visible lesson
 * list so entering cards play an entrance animation and removed cards stay
 * mounted with `state: 'exiting'` long enough for their exit animation to finish.
 */
export function reconcileLessonCards(previousItems = [], nextLessons = []) {
  const safePrev = Array.isArray(previousItems) ? previousItems : [];
  const safeNext = Array.isArray(nextLessons) ? nextLessons : [];

  if (safePrev.length === 0) {
    return safeNext.map((lesson, index) => ({
      lesson,
      state: 'entering',
      index,
    }));
  }

  const activePrev = safePrev.filter((item) => item.state !== 'exiting');
  const sameActiveOrder =
    activePrev.length === safeNext.length &&
    safePrev.length === safeNext.length &&
    activePrev.every((item, idx) => item.lesson.lessonId === safeNext[idx].lessonId);

  if (sameActiveOrder) {
    return safePrev.map((item, idx) => ({
      ...item,
      lesson: safeNext[idx],
      index: idx,
    }));
  }

  const nextById = new Map(safeNext.map((lesson, index) => [lesson.lessonId, { lesson, index }]));
  const prevById = new Map(safePrev.map((item) => [item.lesson.lessonId, item]));
  const placedIds = new Set();
  const merged = [];

  for (const prevItem of safePrev) {
    const id = prevItem.lesson.lessonId;
    if (nextById.has(id)) {
      const { lesson, index } = nextById.get(id);
      merged.push({
        lesson,
        state: prevItem.state === 'exiting' ? 'entering' : 'entered',
        index,
      });
      placedIds.add(id);
    } else {
      merged.push({
        lesson: prevItem.lesson,
        state: 'exiting',
        index: prevItem.index ?? 0,
      });
    }
  }

  for (let i = 0; i < safeNext.length; i++) {
    const lesson = safeNext[i];
    if (placedIds.has(lesson.lessonId)) continue;
    const existed = prevById.get(lesson.lessonId);
    merged.push({
      lesson,
      state: existed && existed.state !== 'exiting' ? 'entered' : 'entering',
      index: i,
    });
    placedIds.add(lesson.lessonId);
  }

  return merged;
}

export function hasExitingLessonCards(items = []) {
  return Array.isArray(items) && items.some((item) => item.state === 'exiting');
}

export function pruneExitingLessonCards(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item.state !== 'exiting')
    .map((item, index) => ({
      ...item,
      state: 'entered',
      index,
    }));
}
