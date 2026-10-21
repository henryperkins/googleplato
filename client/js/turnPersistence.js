import { authenticatedFetch, getImpersonation } from './auth.js';
import { saveObserver, saveFailureReason } from './saveObservability.js';
import { getAuthUser, acceptSavedLessonState } from './storage.js';

export async function assertTurnOwner(userId) {
  if ((await getAuthUser())?.userId !== userId || getImpersonation()) {
    throw new Error('Return to the original account to save this reply.');
  }
}

function validState(state) {
  return Array.isArray(state?.messages?.data) && state?.lessonKB
    && (state.generation === null || typeof state.generation === 'string')
    && (state.lessonKB.data === null || (typeof state.lessonKB.data === 'object' && !Array.isArray(state.lessonKB.data)))
    && ['messages', 'lessonKB'].every(name => Number.isSafeInteger(state[name].version) && state[name].version >= 0);
}

// Bound the whole attempt, including refresh and response parsing. Unknown
// outcomes keep the same turn ID; the server acknowledges an already committed
// retry without appending again. This module has no model/orchestrator imports.
async function requestState(userId, lessonId, turn) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        await assertTurnOwner(userId);
        const response = await authenticatedFetch(`/v1/sync/lesson-turn/${encodeURIComponent(lessonId)}`, {
          signal: controller.signal, cache: 'no-store',
          ...(turn ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(turn) } : {}),
        });
        await assertTurnOwner(userId);
        const rejection = !response.ok ? await response.json().catch(() => ({})) : null;
        if (!response.ok) throw Object.assign(new Error(rejection?.code === 'client_upgrade_required'
          ? 'Update this page to save your retained reply. No new reply will be generated.' : response.status === 409
          ? 'This lesson changed in another session. Your reply is retained; the saved lesson has not been overwritten.'
          : response.status === 413 ? 'This lesson is too large to save. Your reply is retained; ask an administrator for help.'
            : 'Your reply has not been confirmed saved. Retry saving when your connection is available.'), { status: response.status, code: rejection?.code });
        const state = await response.json();
        await assertTurnOwner(userId);
        controller.signal.throwIfAborted();
        if (!validState(state) || (turn && (state.messages.version <= turn.base.messages.version
          || state.lessonKB.version <= turn.base.lessonKB.version
          || state.lessonKB.data?.lessonId !== lessonId || state.lessonKB.data?.startedAt !== turn.lessonKB.startedAt
          || state.generation !== turn.base.generation
          || !turn.messages.every(message => state.messages.data.some(saved => saved.id === message.id && saved.content === message.content && saved.role === message.role))))) {
          throw Object.assign(new Error('The save could not be confirmed. Your reply is retained; retry saving.'), { code: 'invalid_ack' });
        }
        return state;
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('Saving took too long. Your reply is retained; retry saving.'), { name: 'TimeoutError' }));
        }, 15_000);
      }),
    ]);
  } finally { clearTimeout(timeout); }
}

export async function readLessonState(userId, lessonId) {
  return requestState(userId, lessonId);
}

export async function persistLessonTurn(entry) {
  const { turn, persistedLocally } = entry;
  const observation = { userId: turn.userId, operation: 'lesson_turn', key: `${turn.lessonId}:${turn.turnId}` };
  try {
    const state = await requestState(turn.userId, turn.lessonId, turn);
    await assertTurnOwner(turn.userId);
    acceptSavedLessonState(turn.lessonId, state);
    saveObserver.record({ ...observation, ok: true, status: 200 });
    return { status: 'saved', state, persistedLocally, message: 'Your reply is saved.' };
  } catch (error) {
    saveObserver.record({ ...observation, ok: false, status: error.status || 0, reason: saveFailureReason(error) });
    return {
      status: error.code === 'client_upgrade_required' ? 'upgrade_required' : error.status === 409 ? 'conflict' : 'pending', persistedLocally,
      message: error instanceof TypeError ? 'Your reply is retained. Retry saving when your connection is available.' : error.message,
    };
  }
}
