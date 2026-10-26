/**
 * Sequential profile update queue — prevents concurrent updates from overwriting each other.
 */

import {
  getLearnerProfile, saveLearnerProfile, saveLearnerProfileSummary,
} from '../../js/storage.js';
import * as orchestrator from '../../js/orchestrator.js';
import { syncInBackground } from './syncDebounce.js';

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

async function saveProfileResult(existing, result) {
  if (result?.changed === false) return;
  if (!result?.profile) {
    console.error('[plato] Profile update agent returned an invalid result.');
    return;
  }
  const merged = mergeProfile(existing, result.profile);
  await saveLearnerProfile(merged);
  if (result.summary) await saveLearnerProfileSummary(result.summary);
  syncInBackground('profile', 'profileSummary');
}

export async function ensureProfileExists(name = '', options) {
  let profile = await getLearnerProfile();
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
export function updateProfileInBackground(lessonId, assessmentResult) {
  queueProfileUpdate(async () => {
    const profile = await ensureProfileExists();
    const updated = orchestrator.incrementalProfileUpdate(profile, lessonId, assessmentResult);
    await saveLearnerProfile(updated);
    syncInBackground('profile');
  });
}

/**
 * Deep profile update on lesson completion (LLM call).
 */
export function updateProfileOnCompletionInBackground(lessonKB, lesson, context) {
  queueProfileUpdate(async () => {
    const profile = await ensureProfileExists();
    const result = await orchestrator.updateProfileOnCompletion(
      profile, lessonKB, lesson.name, lesson.lessonId, lessonKB.activitiesCompleted, context
    );
    // masteredLessons is system-managed (no longer echoed by the agent —
    // see orchestrator.profileForAgent). Record the completion in code so
    // mergeProfile unions it into the stored profile.
    if (result?.changed === false) result.profile = {};
    if (result?.profile) {
      result.changed = true;
      result.profile.masteredLessons = [lesson.lessonId];
    }
    await saveProfileResult(profile, result);
  });
}

/**
 * Profile update from a coach observation (LLM call).
 */
export function updateProfileFromObservation(lessonKB, observation, context) {
  queueProfileUpdate(async () => {
    const profile = await ensureProfileExists();
    const result = await orchestrator.updateProfileFromFeedback(profile, observation, {
      lessonName: lessonKB.name || 'Lesson', activityType: 'coaching', activityGoal: 'Coach observation',
    }, context);
    await saveProfileResult(profile, result);
  });
}

