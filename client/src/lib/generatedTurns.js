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
    clear(userId, lessonId, turnId) {
      const key = keyFor(userId, lessonId);
      if (this.read(userId, lessonId)?.turn.turnId !== turnId) return;
      memory.delete(key);
      try { storage().removeItem(key); } catch { /* Replaying an old copy is idempotent. */ }
    },
  };
}

export const generatedTurns = createGeneratedTurnStore();
