// A submitted response is not the next editable draft or a generated coach turn.
// Keep its exact input until generation hands off to the existing save journal.
const keyFor = (userId, lessonId) => `plato_lesson_submission:${encodeURIComponent(userId)}:${encodeURIComponent(lessonId)}`;

export function hasLessonDraft(draft) {
  return !!(draft.text || draft.images.length || draft.links.length);
}

export function submissionWasSaved(entry, state) {
  return ['user', 'assistant'].every((role, index) => state.messages.data.some(
    message => message.id === `${entry.id}:${index}` && message.role === role
  ));
}

export function createLessonSubmissionStore({ storage = () => sessionStorage, createId = () => crypto.randomUUID() } = {}) {
  const memory = new Map();
  const listeners = new Set();
  const notify = () => listeners.forEach(listener => listener());
  const persist = entry => {
    try {
      const target = storage();
      const key = keyFor(entry.userId, entry.lessonId);
      const value = JSON.stringify(entry);
      target.setItem(key, value);
      return target.getItem(key) === value;
    } catch { return false; }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read(userId, lessonId) {
      if (!userId || !lessonId) return null;
      const key = keyFor(userId, lessonId);
      if (memory.has(key)) return memory.get(key);
      let entry = null;
      try {
        const saved = JSON.parse(storage().getItem(key));
        if (saved?.userId === userId && saved.lessonId === lessonId && typeof saved.id === 'string'
          && typeof saved.draft?.text === 'string' && Array.isArray(saved.draft.images) && Array.isArray(saved.draft.links)) {
          entry = { ...saved, status: 'interrupted' };
        }
      } catch { /* An unowned or corrupt record cannot supply recovery input. */ }
      memory.set(key, entry);
      return entry;
    },
    stage(userId, lessonId, draft) {
      if (!userId || !lessonId) throw new Error('Sign in to send your response.');
      if (this.read(userId, lessonId)) throw new Error('Recover the earlier response before sending another.');
      const entry = { userId, lessonId, id: createId(), draft: structuredClone(draft), status: 'sending' };
      // Refuse to clear the only copy when browser storage is blocked or full.
      if (!persist(entry)) throw new Error('Your response could not be kept for recovery. Keep this tab open, free browser storage, and try again.');
      memory.set(keyFor(userId, lessonId), entry);
      notify();
      return entry;
    },
    setStatus(entry, status) {
      if (this.read(entry.userId, entry.lessonId)?.id !== entry.id) return;
      const next = { ...entry, status };
      memory.set(keyFor(entry.userId, entry.lessonId), next);
      persist(next);
      notify();
    },
    clear(entry) {
      if (this.read(entry.userId, entry.lessonId)?.id !== entry.id) return;
      // A tombstone also prevents stale disk data from resurfacing when remove
      // is unavailable. If both writes fail, keep recovery visible in this tab.
      const key = keyFor(entry.userId, entry.lessonId);
      try {
        const target = storage();
        target.removeItem(key);
        if (target.getItem(key) !== null) throw new Error('Removal was not retained');
      } catch {
        try {
          storage().setItem(key, 'null');
          if (storage().getItem(key) !== 'null') return false;
        } catch { return false; }
      }
      memory.set(key, null);
      notify();
      return true;
    },
    preserveAllForReload() {
      return [...memory.values()].filter(Boolean).map(persist).every(Boolean);
    },
  };
}

export const lessonSubmissions = createLessonSubmissionStore();
