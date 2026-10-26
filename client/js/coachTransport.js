import { authenticatedFetch } from './auth.js';
import { ApiError } from './api.js';

export async function recoverCoachTurn(lessonId, userId, turnId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await authenticatedFetch(`/v1/ai/coach/${encodeURIComponent(lessonId)}${turnId ? `?turnId=${encodeURIComponent(turnId)}` : ''}`, { expectedUserId: userId, cache: 'no-store', signal: controller.signal });
    // Drain even an empty-cache 404; an unread response can keep browsers'
    // connection/stream resources alive after the lesson has rendered.
    const turn = await response.json().catch(() => null);
    if (!response.ok) return null;
    return turn?.userId === userId && turn.lessonId === lessonId && (!turnId || turn.turnId === turnId) && turn.receipt ? turn : null;
  } finally { clearTimeout(timeout); }
}
export async function requestCoachTurn(lessonId, input, onText, userId) {
  const response = await authenticatedFetch(`/v1/ai/coach/${encodeURIComponent(lessonId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, expectedUserId: userId,
    body: JSON.stringify({ ...input, stream: true }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError('api', error.error || 'The coach could not respond. Your submission is retained.', response.status, error.code);
  }
  let turn;
  if (!response.headers.get('content-type')?.includes('text/event-stream')) turn = await response.json();
  else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === 'coach_text') onText?.(event.text);
          if (event.type === 'coach_turn') turn = event.turn;
          if (event.type === 'error') throw new ApiError('api', event.error || event.message, event.status, event.code);
        }
        if (done) break;
      }
    } finally { reader.releaseLock(); }
  }
  if (!turn?.receipt || turn.userId !== userId || turn.lessonId !== lessonId || turn.turnId !== input.turnId) {
    throw new ApiError('incomplete_response', 'The coach reply is incomplete. Your submission is retained; reload to check for the finished reply.');
  }
  return turn;
}
