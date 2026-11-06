/**
 * Sequential profile update queue — prevents concurrent updates from overwriting each other.
 */

import {
  getAuthUser, getLearnerProfile, getLearnerProfileSummary, saveLearnerProfile, saveLearnerProfileSummary,
} from '../../js/storage.js';
import * as orchestrator from '../../js/orchestrator.js';
import { captureAuthSession, isAuthSessionCurrent } from '../../js/auth.js';
import { assertTurnOwner } from '../../js/turnPersistence.js';

let _profileUpdateQueue = Promise.resolve();

export function queueProfileUpdate(fn, { propagateError = false } = {}) {
  const operation = _profileUpdateQueue.then(fn);
  _profileUpdateQueue = operation.catch(e => {
    console.error('[plato] Profile update failed:', e?.message || e);
  });
  return propagateError ? operation : _profileUpdateQueue;
}

export const MAX_LEARNER_NOTES = 10;
export const MAX_LEARNER_NOTE_LENGTH = 500;
export function withLearnerNote(profile, text, at = Date.now()) {
  const trimmed = String(text || '').trim().slice(0, MAX_LEARNER_NOTE_LENGTH);
  if (!trimmed || profile.learnerNotes?.some(note => note.text === trimmed && note.at === at)) return profile;
  return { ...profile, learnerNotes: [...(profile.learnerNotes || []), { text: trimmed, at }].slice(-MAX_LEARNER_NOTES) };
}
export function withoutLearnerNote(profile, selected) {
  return { ...profile, learnerNotes: (profile.learnerNotes || []).filter(note => note.text !== selected?.text || note.at !== selected?.at) };
}

// The whole read/edit/save/model operation shares the same owner-bound queue.
// A failed optional model rewrite is separate from a successfully saved note.
async function assertProfileOwner(userId, session) {
  if (!userId || !await isAuthSessionCurrent(await session)) throw new Error('Return to the original account to save your profile.');
  await assertTurnOwner(userId);
}

export function addLearnerNote(text, { expectedUserId, at = Date.now() } = {}) {
  const session = captureAuthSession();
  return queueProfileUpdate(async () => {
    await assertProfileOwner(expectedUserId, session);
    const options = { expectedUserId, authSession: await session };
    const profile = await ensureProfileExists('', options);
    const edited = withLearnerNote(profile, text, at);
    if (!text.trim()) throw new Error('Enter a note to save.');
    await saveLearnerProfile(edited, options);
    await assertProfileOwner(expectedUserId, session);
    let changed = false, modelError = null;
    try {
      const result = await orchestrator.updateProfileFromFeedback(edited, text.trim(), {
        lessonName: 'Settings', activityType: 'feedback', activityGoal: 'Learner-provided profile correction',
      }, { userId: expectedUserId }, { source: 'learner' });
      await assertProfileOwner(expectedUserId, session);
      changed = await saveProfileResult(edited, result, options);
    } catch (error) {
      // An account change must reject, including after the durable note save.
      await assertProfileOwner(expectedUserId, session);
      modelError = error.message || 'Profile rewrite unavailable.';
    }
    await assertProfileOwner(expectedUserId, session);
    const summary = await getLearnerProfileSummary(options).catch(error => { modelError ||= error.message; return ''; });
    await assertProfileOwner(expectedUserId, session);
    return { profile: await getLearnerProfile(options), summary, changed, noteSaved: true, modelError };
  }, { propagateError: true });
}

export function removeLearnerNote(selected, { expectedUserId } = {}) {
  const session = captureAuthSession();
  return queueProfileUpdate(async () => {
    await assertProfileOwner(expectedUserId, session);
    const options = { expectedUserId, authSession: await session };
    const profile = await ensureProfileExists('', options);
    const edited = withoutLearnerNote(profile, selected);
    await saveLearnerProfile(edited, options);
    await assertProfileOwner(expectedUserId, session);
    return { profile: edited, summary: await getLearnerProfileSummary(options) };
  }, { propagateError: true });
}

function defaultProfile() {
  return {
    name: '', goal: '',
    masteredLessons: [], activeLessons: [],
    strengths: [], weaknesses: [],
    preferences: {},
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

export function mergeProfile(existing, returned) {
  const merged = { ...existing };
  for (const key of ['name', 'goal']) {
    if (returned[key]) merged[key] = returned[key];
  }
  for (const key of ['masteredLessons', 'activeLessons']) {
    const combined = [...(existing[key] || []), ...(returned[key] || [])];
    merged[key] = [...new Set(combined)];
  }
  for (const key of ['strengths', 'weaknesses']) {
    merged[key] = Array.isArray(returned[key]) ? returned[key] : (existing[key] || []);
  }
  merged.preferences = { ...(existing.preferences || {}), ...(returned.preferences || {}) };
  for (const key of Object.keys(merged.preferences)) if (merged.preferences[key] === null) delete merged.preferences[key];
  merged.createdAt = existing.createdAt || returned.createdAt;
  merged.updatedAt = returned.updatedAt || Date.now();
  return merged;
}

async function saveProfileResult(existing, result, options) {
  if (result?.changed === false) return false;
  if (!result?.profile) {
    throw new Error('The profile update was empty.');
  }
  const merged = mergeProfile(existing, result.profile);
  await saveLearnerProfile(merged, options);
  await assertProfileOwner(options.expectedUserId, options.authSession);
  if (result.summary) await saveLearnerProfileSummary(result.summary, options);
  return true;
}

export async function ensureProfileExists(name = '', options) {
  if (options?.expectedUserId && !options.authSession) options = { ...options, authSession: await captureAuthSession() };
  if (options?.expectedUserId) await assertTurnOwner(options.expectedUserId);
  let profile = await getLearnerProfile(options);
  if (options?.expectedUserId) await assertTurnOwner(options.expectedUserId);
  if (!profile) {
    profile = defaultProfile();
    profile.name = name;
    await saveLearnerProfile(profile, options);
    if (options?.expectedUserId) await assertProfileOwner(options.expectedUserId, options.authSession);
    await saveLearnerProfileSummary('New learner — profile will be built as they learn.', options);
  }
  return profile;
}

/**
 * Incremental profile update after assessment (code, no LLM call).
 */
export function updateProfileInBackground(lessonId, assessmentResult, context) {
  const session = captureAuthSession();
  const owner = context?.userId ? Promise.resolve(context.userId) : getAuthUser().then(user => user?.userId);
  return queueProfileUpdate(async () => {
    const userId = await owner;
    if (!userId) return;
    await assertProfileOwner(userId, session);
    const options = { expectedUserId: userId, authSession: await session };
    const profile = await ensureProfileExists('', options);
    const updated = orchestrator.incrementalProfileUpdate(profile, lessonId, assessmentResult);
    await saveLearnerProfile(updated, options);
  });
}

/**
 * Deep profile update on lesson completion (LLM call).
 */
export function updateProfileOnCompletionInBackground(lessonKB, lesson, context) {
  const session = captureAuthSession();
  const owner = context?.userId ? Promise.resolve(context.userId) : getAuthUser().then(user => user?.userId);
  return queueProfileUpdate(async () => {
    const userId = await owner;
    if (!userId) return;
    await assertProfileOwner(userId, session);
    const options = { expectedUserId: userId, authSession: await session };
    const profile = await ensureProfileExists('', options);
    await assertProfileOwner(userId, session);
    const result = await orchestrator.updateProfileOnCompletion(
      profile, lessonKB, lesson.name, lesson.lessonId, lessonKB.activitiesCompleted, { ...context, userId }
    );
    await assertProfileOwner(userId, session);
    // masteredLessons is system-managed (no longer echoed by the agent —
    // see orchestrator.profileForAgent). Record the completion in code so
    // mergeProfile unions it into the stored profile.
    if (result?.changed === false) result.profile = {};
    if (result?.profile) {
      result.changed = true;
      result.profile.masteredLessons = [lesson.lessonId];
    }
    await saveProfileResult(profile, result, options);
  });
}

/**
 * Profile update from a coach observation (LLM call).
 */
export function updateProfileFromObservation(lessonKB, observation, context) {
  const session = captureAuthSession();
  const owner = context?.userId ? Promise.resolve(context.userId) : getAuthUser().then(user => user?.userId);
  return queueProfileUpdate(async () => {
    const userId = await owner;
    if (!userId) return;
    await assertProfileOwner(userId, session);
    const options = { expectedUserId: userId, authSession: await session };
    const profile = await ensureProfileExists('', options);
    await assertProfileOwner(userId, session);
    const result = await orchestrator.updateProfileFromFeedback(profile, observation, {
      lessonName: lessonKB.name || 'Lesson', activityType: 'coaching', activityGoal: 'Coach observation',
    }, { ...context, userId }, { source: 'coach' });
    await assertProfileOwner(userId, session);
    await saveProfileResult(profile, result, options);
  });
}

