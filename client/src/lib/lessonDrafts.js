const empty = () => ({ text: '', images: [], links: [] });
const keyFor = (userId, lessonId) => `plato_lesson_draft:${encodeURIComponent(userId)}:${encodeURIComponent(lessonId)}`;

// Text, image data and fetched link context stay in the same browser tab.
// Legacy lesson-only text keys are left untouched: their account is unknown.
export function createLessonDraftStore({ storage = () => sessionStorage } = {}) {
  const memory = new Map();
  return {
    read(userId, lessonId) {
      if (!userId || !lessonId) return empty();
      const key = keyFor(userId, lessonId);
      if (memory.has(key)) return structuredClone(memory.get(key).draft);
      try {
        const entry = JSON.parse(storage().getItem(key));
        if (entry?.userId === userId && entry.lessonId === lessonId && typeof entry.draft?.text === 'string'
          && Array.isArray(entry.draft.images) && Array.isArray(entry.draft.links)) return entry.draft;
      } catch { /* Missing or unusable recovery never supplies another account's draft. */ }
      return empty();
    },
    write(userId, lessonId, draft) {
      if (!userId || !lessonId) return false;
      const key = keyFor(userId, lessonId);
      memory.set(key, { userId, lessonId, draft: structuredClone(draft) });
      try {
        const serialized = JSON.stringify({ userId, lessonId, draft });
        const target = storage();
        target.setItem(key, serialized);
        return target.getItem(key) === serialized;
      } catch { return false; }
    },
    preserveAllForReload() {
      let safe = true;
      for (const { userId, lessonId, draft } of memory.values()) {
        if (!this.write(userId, lessonId, draft)) safe = false;
      }
      return safe;
    },
  };
}

export const lessonDrafts = createLessonDraftStore();
