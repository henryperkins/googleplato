/**
 * Lesson creation engine helpers used by the Lesson Creator, Customizer, and
 * KB Setup chat views. The actual creation flow lives in LessonEditor and the
 * knowledge-base editor — this file only exports shared parsing utilities.
 */

import { MIN_OBJECTIVES, MAX_OBJECTIVES } from './constants.js';

const READINESS_REGEX = /\[READINESS:\s*(\d+)\]\s*$/;

/** Match the server's objective format before offering a preview for saving. */
export function lessonObjectiveError(markdown) {
  const section = markdown.split(/^## Learning Objectives$/m)[1]?.split(/^## /m)[0];
  const count = (section?.match(/^- Can .+/gm) || []).length;
  return count < MIN_OBJECTIVES || count > MAX_OBJECTIVES
    ? `The preview needs ${MIN_OBJECTIVES}–${MAX_OBJECTIVES} measurable learning objectives. Generate it again, or refine the lesson in chat.`
    : null;
}

/** Strip the readiness tag from a response and return { text, readiness }. */
export function parseResponse(raw) {
  const match = raw.match(READINESS_REGEX);
  const readiness = match ? parseInt(match[1], 10) : null;
  const text = stripReadiness(raw);
  return { text, readiness };
}

/** Strip any readiness tag from text. */
function stripReadiness(text) {
  return text.replace(READINESS_REGEX, '').trim();
}

/** Wrap a stream callback to strip the readiness tag from partial text. */
export function cleanStream(onStream) {
  if (!onStream) return () => {};
  return (partial) => onStream(stripReadiness(partial));
}

/**
 * Rebuild a chat-message array into the "User: …\n\nAgent: …" text the
 * lesson-extractor agent expects. Shared by the lesson editor's finalize
 * ("Create/Update Lesson") and preview-refresh paths so both feed the
 * extractor the exact same input.
 */
export function buildConversationText(chatMessages) {
  return (chatMessages || [])
    .map((m) => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`)
    .join('\n\n');
}
