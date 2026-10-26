/**
 * Sequential profile update queue — prevents concurrent updates from overwriting each other.
 */

import {
  getAuthUser, getLearnerProfile, saveLearnerProfile, saveLearnerProfileSummary,
} from '../../js/storage.js';
import * as orchestrator from '../../js/orchestrator.js';
import { assertTurnOwner } from '../../js/turnPersistence.js';

let _profileUpdateQueue = Promise.resolve();

export function queueProfileUpdate(fn) {
  _profileUpdateQueue = _profileUpdateQueue.then(fn).catch(e => {
    console.error('[plato] Profile update failed:', e?.message || e, e?.stack);
  });
  return _profileUpdateQueue;
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
  if (result?.changed === false) return;
  if (!result?.profile) {
    console.error('[plato] Profile update agent returned an invalid result.');
    return;
  }
  const merged = mergeProfile(existing, result.profile);
  await saveLearnerProfile(merged, options);
  if (result.summary) await saveLearnerProfileSummary(result.summary, options);
}

export async function ensureProfileExists(name = '', options) {
  if (options?.expectedUserId) await assertTurnOwner(options.expectedUserId);
  let profile = await getLearnerProfile(options);
  if (options?.expectedUserId) await assertTurnOwner(options.expectedUserId);
  if (!profile) {
    profile = defaultProfile();
    profile.name = name;
    await saveLearnerProfile(profile, options);
    await saveLearnerProfileSummary('New learner — profile will be built as they learn.', options);
  }
  return profile;
}

/**
 * Incremental profile update after assessment (code, no LLM call).
 */
export function updateProfileInBackground(lessonId, assessmentResult, context) {
  const owner = context?.userId ? Promise.resolve(context.userId) : getAuthUser().then(user => user?.userId);
  return queueProfileUpdate(async () => {
    const userId = await owner;
    if (!userId) return;
    await assertTurnOwner(userId);
    const options = { expectedUserId: userId };
    const profile = await ensureProfileExists('', options);
    const updated = orchestrator.incrementalProfileUpdate(profile, lessonId, assessmentResult);
    await saveLearnerProfile(updated, options);
  });
}

/**
 * Deep profile update on lesson completion (LLM call).
 */
export function updateProfileOnCompletionInBackground(lessonKB, lesson, context) {
  const owner = context?.userId ? Promise.resolve(context.userId) : getAuthUser().then(user => user?.userId);
  return queueProfileUpdate(async () => {
    const userId = await owner;
    if (!userId) return;
    await assertTurnOwner(userId);
    const options = { expectedUserId: userId };
    const profile = await ensureProfileExists('', options);
    const result = await orchestrator.updateProfileOnCompletion(
      profile, lessonKB, lesson.name, lesson.lessonId, lessonKB.activitiesCompleted, { ...context, userId }
    );
    await assertTurnOwner(userId);
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
  const owner = context?.userId ? Promise.resolve(context.userId) : getAuthUser().then(user => user?.userId);
  return queueProfileUpdate(async () => {
    const userId = await owner;
    if (!userId) return;
    await assertTurnOwner(userId);
    const options = { expectedUserId: userId };
    const profile = await ensureProfileExists('', options);
    const result = await orchestrator.updateProfileFromFeedback(profile, observation, {
      lessonName: lessonKB.name || 'Lesson', activityType: 'coaching', activityGoal: 'Coach observation',
    }, { ...context, userId });
    await assertTurnOwner(userId);
    await saveProfileResult(profile, result, options);
  });
}

