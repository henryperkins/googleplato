const keyFor = (userId, lessonId) => userId && lessonId
  ? `plato_compose_draft_v2:${encodeURIComponent(userId)}:${encodeURIComponent(lessonId)}`
  : null;

// Legacy lesson-only keys have no reliable owner. A separate namespace also
// prevents legacy lesson IDs containing colons from looking like owned keys.
export function createLessonDraftStore({ storage = () => sessionStorage } = {}) {
  return {
    read(userId, lessonId) {
      const key = keyFor(userId, lessonId);
      if (!key) return '';
      try { return storage().getItem(key) || ''; } catch { return ''; }
    },
    write(userId, lessonId, text) {
      const key = keyFor(userId, lessonId);
      if (!key) return;
      try {
        if (text) storage().setItem(key, text);
        else storage().removeItem(key);
      } catch { /* Editing still works when tab storage is unavailable. */ }
    },
  };
}

export const lessonDrafts = createLessonDraftStore();
