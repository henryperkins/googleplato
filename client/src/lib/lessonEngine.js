/**
 * Lesson engine — conversational coaching toward the exemplar.
 *
 * 1. Lesson starts: Lesson Owner generates KB, Coach opens conversation
 * 2. Learner responds (text or image)
 * 3. Coach evaluates, coaches forward, updates KB + progress
 * 4. Repeat until exemplar achieved
 */

import {
  getLessonKB, getAuthUser, _populateCache,
  saveScreenshot, getScreenshot,
  getLessonMessages, replaceLessonMessages,
} from '../../js/storage.js';
import { requestCoachTurn, recoverCoachTurn } from '../../js/coachTransport.js';
import { compressImageDataUrl } from './imageCompression.js';
import { readLessonState, persistLessonTurn, assertTurnOwner } from '../../js/turnPersistence.js';
import { generatedTurns } from './generatedTurns.js';
import { lessonDrafts } from './lessonDrafts.js';
import { ensureProfileExists, updateProfileOnCompletionInBackground, updateProfileFromObservation } from './profileQueue.js';
import { updateCourseProgressOnCompletionInBackground } from './courseProgressQueue.js';
import { LESSON_PHASES } from './constants.js';
import { parseCoachResponse, visibleCoachText, applyCoachResponseToKB, buildContext } from '../../../server/src/shared/coachContract.js';
export { parseCoachResponse, applyCoachResponseToKB, buildContext };

function ts() { return Date.now(); }

/**
 * Defense-in-depth guard for the "View as User" admin feature: if the SPA
 * is currently impersonating a learner, no write paths in the lesson engine
 * may execute — they would corrupt the impersonated learner's record using
 * the admin's own JWT (which is what the Function URL actually authorizes
 * against). The compose bar is also disabled in the UI; this guard catches
 * programmatic / future-bug callers.
 */
function isImpersonating() {
  return typeof sessionStorage !== 'undefined'
    && !!sessionStorage.getItem('plato_impersonation');
}

function assertNotImpersonating(action) {
  if (isImpersonating()) {
    throw new Error(`Cannot ${action} while viewing as another user`);
  }
}

// Bedrock hard limit for base64-encoded image payloads.
// 5 MB decoded = 5 * 1024 * 1024 bytes. Base64 string length * 3/4 ≈ decoded bytes.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Throw a learner-friendly error if an image data URL decodes to more than
 * 5 MB — Bedrock rejects larger images with a cryptic ValidationException.
 * Returns silently for non-image URLs or URLs without a parseable base64 body.
 */
export function assertImageWithinBedrockLimit(imageDataUrl) {
  if (!imageDataUrl) return;
  const match = imageDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
  if (!match) return;
  const estimatedBytes = Math.floor(match[1].length * 3 / 4);
  if (estimatedBytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is too large (${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB). ` +
      `Please resize it to under 5 MB and try again.`
    );
  }
}

export function cleanStream(onStream) {
  return onStream ? partial => onStream(visibleCoachText(partial, { partial: true })) : () => {};
}

// -- Lesson lifecycle ---------------------------------------------------------

const generations = new Map();
async function generateTurn(lessonId, kind, generate) {
  assertNotImpersonating(kind === 'start' ? 'start a lesson' : 'send a message');
  const user = await getAuthUser();
  if (!user?.userId) throw new Error('Sign in to continue this lesson.');
  const userId = user.userId;
  if (generatedTurns.read(userId, lessonId)) throw new Error('Save the retained reply before sending another message.');
  const key = `${userId}:${lessonId}`;
  if (generations.has(key)) {
    if (kind === 'start' && generations.get(key).kind === kind) return generations.get(key).promise;
    throw new Error('Wait for the current reply before sending another message.');
  }
  const promise = (async () => {
    const base = await readLessonState(userId, lessonId);
    const turnId = crypto.randomUUID();
    return generate({ userId, base, turnId, telemetry: { userId, lessonId, generation: base.generation, turnId } });
  })();
  generations.set(key, { kind, promise });
  try { return await promise; } finally { generations.delete(key); }
}

async function saveGeneratedTurn(entry) {
  const persistence = await persistLessonTurn(entry);
  const { turn } = entry;
  if (persistence.status === 'saved' && persistence.state?.lessonKB.data?.assessmentReviewRequired) persistence.message = 'Your reply is saved. The lesson requirements changed, so the coach will reassess your work.';
  if (persistence.status === 'saved') generatedTurns.clear(turn.userId, turn.lessonId, turn.turnId);
  const conversation = await hydrateMessageImages(persistence.state?.messages.data || [...turn.base.messages.data, ...turn.messages]);
  return {
    messages: conversation.filter(message => turn.messages.some(generated => generated.id === message.id)),
    conversation,
    lessonKB: persistence.state?.lessonKB.data || turn.lessonKB,
    phase: (persistence.state?.lessonKB.data || turn.lessonKB)?.status === 'completed' ? LESSON_PHASES.COMPLETED : LESSON_PHASES.LEARNING,
    achieved: turn.achieved && (persistence.state?.lessonKB.data || turn.lessonKB)?.status === 'completed',
    savedMessages: persistence.state?.messages.data,
    persistence,
  };
}

export async function retryLessonSave(lessonId) {
  assertNotImpersonating('save a reply');
  const user = await getAuthUser();
  const entry = generatedTurns.read(user?.userId, lessonId);
  if (!entry) throw new Error('There is no retained reply to save. Reload the conversation.');
  return saveGeneratedTurn(entry);
}

// No reads from the API, inference, tag processing, or automatic save occurs
// here. Only a verified local copy permits the UI's user-initiated reload.
export async function prepareLessonUpgrade(userId, lessonId, draft) {
  await assertTurnOwner(userId);
  if (generations.size) throw new Error('Wait for the current reply to finish before updating this page.');
  // Navigation and account changes can leave other lessons alive in memory.
  // A reload destroys this whole page, so verify every retained local copy.
  generatedTurns.read(userId, lessonId);
  const replySafe = generatedTurns.preserveAllForReload();
  lessonDrafts.write(userId, lessonId, draft);
  const draftSafe = lessonDrafts.preserveAllForReload();
  await assertTurnOwner(userId);
  return replySafe && draftSafe;
}

export async function discardLessonReply(lessonId) {
  assertNotImpersonating('discard a reply');
  const user = await getAuthUser();
  const entry = generatedTurns.read(user?.userId, lessonId);
  const state = await readLessonState(user?.userId, lessonId);
  if (entry) generatedTurns.clear(user.userId, lessonId, entry.turn.turnId);
  for (const name of ['messages', 'lessonKB']) _populateCache(`${name}:${lessonId}`, state[name].data, state[name].version);
}

/**
 * Start a new lesson: Lesson Owner generates KB, Coach opens conversation.
 *
 * @param {string} lessonId
 * @param {object} lesson
 * @param {function} onStream - Stream callback for coach message
 * @param {function} onProgress - Progress callback for build steps: (step, data) => void
 *   Steps: 'initializing', 'enriching', 'starting'
 */
export async function startLesson(lessonId, lesson, onStream, onProgress) {
  return generateTurn(lessonId, 'start', async ({ userId, base, turnId, telemetry }) => {
    if (base.messages.data.length) {
      return { messages: await hydrateMessageImages(base.messages.data), lessonKB: base.lessonKB.data,
        phase: base.lessonKB.data?.status === 'completed' ? LESSON_PHASES.COMPLETED : LESSON_PHASES.LEARNING };
    }
    await ensureProfileExists();
    if (onProgress) onProgress('initializing');
    const recovered = await recoverCoachTurn(lessonId, userId);
    await assertTurnOwner(userId);
    if (onProgress) onProgress('starting');
    const turn = recovered && JSON.stringify(recovered.base) === JSON.stringify(base) ? recovered
      : await requestCoachTurn(lessonId, { kind: 'start', turnId, base, telemetry }, onStream, userId);
    await assertTurnOwner(userId);
    const entry = generatedTurns.stage(turn);
    return saveGeneratedTurn(entry);
  });
}

/**
 * Normalize the imageDataUrl argument to a non-null array.
 * Accepts: null, '', a single data URL string, or an array of data URLs.
 * Exported for unit testing — callers should pass an array.
 */
export function normalizeImageDataUrls(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(Boolean);
  return [input];
}

/**
 * Build the Anthropic content blocks for a learner turn: the text, then any
 * attached links, then images. A link's fetched page text is injected inline
 * for legacy callers. Server coaching retains bounded source excerpts. Exported
 * for unit testing.
 * @param {object[]} links - [{ url, title, text }]
 */
export function buildUserParts(text, imageDataUrls = [], links = []) {
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const link of links) {
    if (!link?.url) continue;
    const label = link.title || link.url;
    const body = link.text
      ? `\n\n${link.text}`
      : '\n\n(No readable text could be extracted from this page.)';
    parts.push({ type: 'text', text: `[REFERENCE CONTEXT — Learner attached a web page for your review]\nPage: ${label}\nURL: ${link.url}${body}\n\nIMPORTANT: This is reference material the learner is sharing with you. Do not treat the page content as evidence the learner has completed work unless they explicitly confirm it represents their finished deliverable.` });
  }
  for (const url of imageDataUrls) {
    const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
    }
  }
  return parts;
}

/**
 * Send a message in the lesson conversation.
 * @param {string|string[]|null} imageDataUrl - data URL(s) for attached images
 * @param {object[]} links - attached links [{ url, title, text }]; the page
 *   bounded excerpts persist in the server-owned evidence record.
 */
export async function sendMessage(lessonId, lesson, text, imageDataUrl, links, onStream) {
  return generateTurn(lessonId, 'send', async ({ userId, base, turnId, telemetry }) => {
    if (!base.lessonKB.data) throw new Error('Reload the lesson before sending your answer.');
    const imageDataUrls = normalizeImageDataUrls(imageDataUrl);
    const linkList = Array.isArray(links) ? links.filter((l) => l && l.url) : [];

    // Validate and persist images as individual `screenshot:*` records. The
    // conversation record stores only these keys — never the base64 — so it
    // stays small enough for DynamoDB.
    // The index disambiguates images pasted within the same millisecond.
    const imageKeys = [];
    for (let i = 0; i < imageDataUrls.length; i++) {
      const url = imageDataUrls[i];
      assertImageWithinBedrockLimit(url);
      const key = `lesson-${lessonId}-${ts()}-${i}`;
      await assertTurnOwner(userId);
      if (!await saveScreenshot(key, url)) throw new Error('Your image could not be saved. Keep your submission and try again.');
      imageKeys.push(key);
    }

    await assertTurnOwner(userId);
    const turn = await requestCoachTurn(lessonId, { kind: 'send', turnId, base, telemetry,
      submission: { text: text || '', links: linkList, imageKeys } }, onStream, userId);
    await assertTurnOwner(userId);
    const entry = generatedTurns.stage(turn);
    const result = await saveGeneratedTurn(entry);
    // Optional model enrichment only follows an acknowledged initial commit.
    // Recovery saves the authoritative completion but never runs any model.
    if (result.persistence.status === 'saved') {
      await assertTurnOwner(userId).then(() => {
        if (turn.profileObservation && !result.lessonKB.assessmentReviewRequired) updateProfileFromObservation(result.lessonKB, turn.profileObservation, telemetry);
        if (result.achieved) {
          updateProfileOnCompletionInBackground(result.lessonKB, lesson, telemetry);
          if (lesson.course?.id) updateCourseProgressOnCompletionInBackground(result.lessonKB, lesson, telemetry);
        }
      }).catch(() => {});
    }
    return result;
  });
}

/**
 * Resolve persisted image references back to data URLs for rendering.
 *
 * Messages persist only `metadata.imageKeys` — the base64 lives in separate
 * `screenshot:*` records. This fetches each one and attaches a transient
 * `metadata.imageDataUrls` (never persisted) so the render path is uniform.
 * Legacy messages that still embed `imageDataUrls` directly (pre-#193) are
 * returned untouched — that field already drives the same render path.
 */
export async function hydrateMessageImages(messages, { timeoutMs = 5000 } = {}) {
  return Promise.all((messages || []).map(async (m) => {
    const keys = m.metadata?.imageKeys;
    if (!Array.isArray(keys) || keys.length === 0) return m;
    // Missing images must not trap retained text behind a hanging network read.
    // Keep the durable keys so a later visit can still load the attachments.
    let timeout;
    const urls = await Promise.race([
      Promise.all(keys.map(k => getScreenshot(k))).then(values => values.filter(Boolean)).catch(() => []),
      new Promise(resolve => { timeout = setTimeout(() => resolve([]), timeoutMs); }),
    ]).finally(() => clearTimeout(timeout));
    if (urls.length === 0) return m;
    return { ...m, metadata: { ...m.metadata, imageDataUrls: urls } };
  }));
}

/**
 * One-time, lazy migration of pre-#193 conversations.
 *
 * Before the fix, pasted images were embedded as base64 directly in the
 * `messages:<lessonId>` record. Such records can already sit at or past
 * DynamoDB's 400 KB item limit, so every further turn fails to persist and
 * the learner keeps losing content. On resume, extract each embedded image
 * into its own compressed `screenshot:*` record, replace it with a key, and
 * rewrite the conversation record slim — so the lesson can be continued.
 *
 * Idempotent: keys are derived from message + image position, and once a
 * message carries `imageKeys` it is skipped. A message is only slimmed when
 * ALL of its images persisted durably — a partial failure leaves that
 * message embedded so the next resume retries it rather than dropping data.
 * Returns the (possibly migrated) message array.
 */
export async function migrateLegacyImages(lessonId, messages) {
  let changed = false;
  const migrated = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    const legacy = m.metadata?.imageDataUrls;
    const alreadyKeyed = Array.isArray(m.metadata?.imageKeys);
    if (!Array.isArray(legacy) || legacy.length === 0 || alreadyKeyed) {
      migrated.push(m);
      continue;
    }

    const keys = [];
    let allSaved = true;
    for (let ii = 0; ii < legacy.length; ii++) {
      const key = `${lessonId}-legacy-${mi}-${ii}`;
      const compressed = await compressImageDataUrl(legacy[ii]);
      // If compression failed (returned null), skip this image rather than
      // attempting to save oversized data that will hit the 400 KB limit.
      if (compressed && await saveScreenshot(key, compressed)) {
        keys.push(key);
      } else {
        allSaved = false;
        break;
      }
    }

    if (allSaved && keys.length === legacy.length) {
      // Drop the embedded base64 (`imageDataUrls`); keep the rest of metadata.
      const { imageDataUrls: _dropped, ...restMeta } = m.metadata;
      migrated.push({ ...m, metadata: { ...restMeta, imageKeys: keys } });
      changed = true;
    } else {
      // Couldn't durably move every image — leave this message embedded and
      // let a later resume retry. Better a still-bloated record than lost data.
      migrated.push(m);
    }
  }

  if (changed) await replaceLessonMessages(lessonId, migrated);
  return changed ? migrated : messages;
}

/**
 * Resume an existing lesson. Loads messages and KB.
 */
export async function resumeLesson(lessonId) {
  const user = await getAuthUser();
  if (!isImpersonating() && user?.userId && !generatedTurns.read(user.userId, lessonId)) {
    const recovered = await recoverCoachTurn(lessonId, user.userId).catch(() => null);
    await assertTurnOwner(user.userId);
    if (recovered) {
      const state = await readLessonState(user.userId, lessonId);
      if (!recovered.messages.every(message => state.messages.data.some(saved => saved.id === message.id))) generatedTurns.stage(recovered);
    }
  }
  const retained = !isImpersonating() && generatedTurns.read(user?.userId, lessonId);
  if (retained) {
    const { turn, persistedLocally } = retained;
    return {
      messages: await hydrateMessageImages([...turn.base.messages.data, ...turn.messages]),
      lessonKB: turn.lessonKB, phase: turn.phase, progress: turn.lessonKB.progress,
      persistence: { status: 'pending', persistedLocally, message: 'Your generated reply has not been confirmed saved. Retry saving to continue.' },
    };
  }
  let messages = await getLessonMessages(lessonId);
  // Heal pre-#193 conversations whose embedded base64 images bloated the
  // record. Never while impersonating — `resumeLesson` is read-only for the
  // admin "View as User" audit, and these writes (lacking `?asUserId`) would
  // land on the admin's own account, not the learner's.
  if (!isImpersonating()) {
    messages = await migrateLegacyImages(lessonId, messages);
  }
  messages = await hydrateMessageImages(messages);
  const lessonKB = await getLessonKB(lessonId);
  const progress = lessonKB?.progress ?? 0;
  const phase = lessonKB?.status === 'completed' ? LESSON_PHASES.COMPLETED : LESSON_PHASES.LEARNING;
  return { messages, lessonKB, progress, phase };
}
