const keyFor = (userId, lessonId) => userId && lessonId
  ? `plato_compose_draft:${encodeURIComponent(userId)}:${encodeURIComponent(lessonId)}`
  : null;

// Legacy lesson-only keys have no reliable owner. Leave them intact, but never
// restore them into an authenticated account or an impersonated read-only view.
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
