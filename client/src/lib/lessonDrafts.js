const empty = () => ({ text: '', images: [], links: [] });
const keyFor = (userId, lessonId) => `plato_lesson_draft:${encodeURIComponent(userId)}:${encodeURIComponent(lessonId)}`;
const textKeyFor = (userId, lessonId) => `plato_compose_draft_v2:${encodeURIComponent(userId)}:${encodeURIComponent(lessonId)}`;

// Text, image data and fetched link context stay in the same browser tab.
// Legacy lesson-only text keys are left untouched: their account is unknown.
export function createLessonDraftStore({ storage = () => sessionStorage } = {}) {
  const memory = new Map();
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retentionStatus(userId, lessonId) {
      if (!userId || !lessonId) return 'unavailable';
      const entry = memory.get(keyFor(userId, lessonId));
      return entry ? (entry.retained ? 'retained' : 'failed') : 'pending';
    },
    read(userId, lessonId) {
      if (!userId || !lessonId) return empty();
      const key = keyFor(userId, lessonId);
      if (memory.has(key)) return structuredClone(memory.get(key).draft);
      try {
        const target = storage();
        const raw = target.getItem(key);
        if (raw !== null) {
          const entry = JSON.parse(raw);
          if (entry?.userId === userId && entry.lessonId === lessonId && typeof entry.draft?.text === 'string'
            && Array.isArray(entry.draft.images) && Array.isArray(entry.draft.links)) return entry.draft;
          return empty();
        }
        // Main's previous text-only format already identifies the owner.
        // Never fall back after an explicit empty draft in the newer format.
        const text = target.getItem(textKeyFor(userId, lessonId));
        if (typeof text === 'string') return { ...empty(), text };
      } catch { /* Missing or unusable recovery never supplies another account's draft. */ }
      return empty();
    },
    write(userId, lessonId, draft) {
      if (!userId || !lessonId) return false;
      const key = keyFor(userId, lessonId);
      const entry = { userId, lessonId, draft: structuredClone(draft), retained: false };
      memory.set(key, entry);
      const finish = retained => {
        entry.retained = retained;
        listeners.forEach(listener => listener());
        return retained;
      };
      try {
        const serialized = JSON.stringify({ userId, lessonId, draft });
        const target = storage();
        target.setItem(key, serialized);
        if (target.getItem(key) !== serialized) return finish(false);
        try { target.removeItem?.(textKeyFor(userId, lessonId)); } catch { /* The verified newer copy takes precedence. */ }
        return finish(true);
      } catch { return finish(false); }
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
