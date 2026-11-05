import { isDeepStrictEqual } from 'node:util';
import db from './db.js';
import { reconcileConversationState } from '../shared/coachConversation.js';
import { MAX_SCREENSHOT_RECORD_BYTES } from './sync-limits.js';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const conflict = () => failure('This lesson changed. Read and back up the current conversation before repairing it.', 409);
const id = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);

// This administrative operation changes continuity/observations only. It uses
// the same atomic snapshot comparison as a generated turn and never infers,
// rewrites transcript messages, or grants/revokes assessment evidence.
export async function repairCoachContinuity(userId, lessonId, input) {
  if (!id(userId) || userId.startsWith('_') || !id(lessonId) || !input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['base', 'assignmentMessageId', 'learnerMessageId', 'misleadingInsights'].includes(key))
    || !input.base || typeof input.base !== 'object'
    || typeof input.assignmentMessageId !== 'string' || input.assignmentMessageId.length > 160
    || typeof input.learnerMessageId !== 'string' || input.learnerMessageId.length > 160
    || !Array.isArray(input.misleadingInsights) || input.misleadingInsights.length > 10
    || input.misleadingInsights.some(item => typeof item !== 'string' || !item.trim() || item.length > 300)) {
    throw failure('Invalid continuity repair. Supply the exact saved snapshot and existing source message IDs.');
  }
  if (!await db.getUserById(userId)) throw failure('Learner not found.', 404);
  const current = await db.getLessonState(userId, lessonId);
  if (!isDeepStrictEqual(current, input.base)) throw conflict();
  const kb = current.lessonKB.data;
  if (!kb || kb.status === 'completed') throw failure('Only an active saved lesson can receive a continuity repair.', 409);
  const messages = current.messages.data;
  const assignmentIndex = messages.findIndex(message => message.id === input.assignmentMessageId && message.role === 'assistant');
  const learnerIndex = messages.findLastIndex(message => message.role === 'user');
  const observation = messages[learnerIndex];
  const last = messages.at(-1);
  if (assignmentIndex < 0 || assignmentIndex >= learnerIndex || observation?.id !== input.learnerMessageId
    || typeof observation.content !== 'string' || !observation.content.trim() || last?.role !== 'assistant'
    || input.misleadingInsights.some(insight => !kb.insights?.includes(insight))) {
    throw failure('Repair sources must identify an earlier assignment, the latest learner observation, and existing notes.');
  }
  const conversationState = reconcileConversationState({ ...kb.conversationState,
    assignment: { sourceMessageId: input.assignmentMessageId } }, messages);
  if (conversationState.assignment?.sourceMessageId !== input.assignmentMessageId) throw failure('The selected assignment has no readable text.');
  conversationState.correction = { reason: 'assignment-drift', afterMessageId: last.id, learnerMessageId: observation.id };
  const lessonKB = { ...kb, conversationState,
    insights: (kb.insights || []).filter(insight => !input.misleadingInsights.includes(insight)),
    learnerPosition: `Latest learner observation (not a diagnosis): ${observation.content.slice(0, 1200)}\nClarify the visible element and effect before inferring a cause.` };
  // Match the portable generated-turn limit, including DynamoDB's overhead.
  if (Buffer.byteLength(JSON.stringify({ userId, dataKey: `lessonKB:${lessonId}`, data: lessonKB }), 'utf8') > MAX_SCREENSHOT_RECORD_BYTES) {
    throw failure('The repaired lesson would exceed the saved-record limit.', 413);
  }
  try { return await db.commitLessonTurn(userId, lessonId, current, { messages, lessonKB }); }
  catch (error) {
    if (error.name === 'ConditionalCheckFailedException') throw conflict();
    throw error;
  }
}
