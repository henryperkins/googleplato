import { assertTurnOwner } from './turnPersistence.js';

// One logical agent operation can make several paid requests (overload or
// output-validation retries). Reuse its ID, but count each request separately.
// The existing reset generation joins reloads; nothing new needs local storage.
export function createInferenceOperation(agentRole, context = {}) {
  const { userId, lessonId, generation, turnId } = context;
  const operationId = crypto.randomUUID();
  let retryIndex = 0;
  return {
    async next() {
      if (userId) await assertTurnOwner(userId);
      return { agentRole, operationId, retryIndex: retryIndex++,
        ...(lessonId ? { lessonId, generation, turnId } : {}) };
    },
  };
}
