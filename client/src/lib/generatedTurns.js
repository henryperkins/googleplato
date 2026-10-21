// Keep generated output separate from editable drafts. A retry can only save
// this exact turn. Account and lesson IDs isolate recovery on shared devices.
const keyFor = (userId, lessonId) => `plato_generated_turn:${encodeURIComponent(userId)}:${encodeURIComponent(lessonId)}`;

export function createGeneratedTurnStore({ storage = () => sessionStorage } = {}) {
  const memory = new Map();
  return {
    stage(turn) {
      const key = keyFor(turn.userId, turn.lessonId);
      const entry = { turn: structuredClone(turn), persistedLocally: false };
      memory.set(key, entry);
      try {
        storage().setItem(key, JSON.stringify(entry.turn));
        entry.persistedLocally = true;
      } catch { /* The UI warns when recovery is available only in memory. */ }
      return entry;
    },
    read(userId, lessonId) {
      if (!userId || !lessonId) return null;
      const key = keyFor(userId, lessonId);
      if (memory.has(key)) return memory.get(key);
      try {
        const turn = JSON.parse(storage().getItem(key));
        if (turn?.userId === userId && turn.lessonId === lessonId && turn.turnId
          && turn.base && Array.isArray(turn.messages) && turn.messages.length && turn.lessonKB) {
          const entry = { turn, persistedLocally: true };
          memory.set(key, entry);
          return entry;
        }
      } catch { /* No usable recovery record. */ }
      return null;
    },
    preserveForReload(userId, lessonId) {
      const entry = this.read(userId, lessonId);
      if (!entry) return true;
      entry.persistedLocally = false;
      try {
        const serialized = JSON.stringify(entry.turn);
        const target = storage();
        target.setItem(keyFor(userId, lessonId), serialized);
        entry.persistedLocally = target.getItem(keyFor(userId, lessonId)) === serialized;
      } catch { /* Keep the only copy in memory; the caller must not reload. */ }
      return entry.persistedLocally;
    },
    preserveAllForReload() {
      let safe = true;
      for (const { turn } of memory.values()) {
        if (!this.preserveForReload(turn.userId, turn.lessonId)) safe = false;
      }
      return safe;
    },
    clear(userId, lessonId, turnId) {
      const key = keyFor(userId, lessonId);
      if (this.read(userId, lessonId)?.turn.turnId !== turnId) return;
      memory.delete(key);
      try { storage().removeItem(key); } catch { /* Replaying an old copy is idempotent. */ }
    },
  };
}

export const generatedTurns = createGeneratedTurnStore();
