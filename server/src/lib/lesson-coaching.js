import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import db from './db.js';
import ai, { LLM } from './ai-provider.js';
import { normalizeStatus } from './lesson-visibility.js';
import { parseLessonPrompt } from '../shared/lessonMarkdown.js';
import { validateLessonKB } from '../shared/lessonInitialization.js';
import { visibleCoachText, reconcileLessonKB, buildContext, submissionSources, retainSources, sourceIdsForEvidence, applyCoachResponseToKB, profileObservationForTurn } from '../shared/coachContract.js';
import { signCoachTurn, digest, receiptKey } from './coach-receipt.js';
import { inferenceContext, withInferenceContext } from './inference-telemetry.js';
import { emit } from './plugins/hooks.js';
import { logger } from './logger.js';
import { readCoachResult, storeCoachResult } from './coach-recovery.js';
import { assessCoachResponse } from './coach-assessment.js';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const idPattern = /^[\w-]{1,100}$/;
const inflight = new Map();
const empty = () => ({ status: 'missing', observation: '', sourceIds: [] });
export const lessonCriteriaHash = lesson => digest({ exemplar: lesson.exemplar, objectives: lesson.learningObjectives, directive: lesson.coachDirective || '', origin: lesson.origin });
export async function resolveCoachLesson(userId, lessonId) {
  const system = await db.getSyncData('_system', `lesson:${lessonId}`, { consistentRead: true });
  let record = system?.data;
  if (record) {
    const status = normalizeStatus(record.status, !!record.markdown);
    if (status === 'draft' || (status !== 'public' && !record.sharedWith?.includes(userId))) throw failure('Lesson unavailable.', 404);
  } else record = (await db.getSyncData(userId, `lessons:${lessonId}`, { consistentRead: true }))?.data;
  if (!record?.markdown || record.markdown.length > 100000) throw failure('Lesson unavailable.', 404);
  const lesson = { ...parseLessonPrompt(lessonId, record.markdown), markdown: record.markdown, origin: system ? 'system' : 'custom' };
  if (!lesson.exemplar || !lesson.learningObjectives.length) throw failure('The lesson needs authored assessment criteria.', 422);
  if (typeof record.course === 'string') {
    const course = (await db.getSyncData('_system', `course:${record.course}`))?.data;
    if (course) lesson.course = { id: record.course, name: course.name };
  }
  return lesson;
}
export async function loadCoachPrompt(name) {
  const stored = (await db.getSyncData('_system', `prompt:${name}`))?.data?.content;
  // The bundled coach protocol always constrains an admin's teaching prompt.
  let bundled;
  for (const path of [`../../../client/prompts/${name}.md`, `../../client-content/prompts/${name}.md`]) {
    try { bundled = await readFile(new URL(path, import.meta.url), 'utf8'); break; } catch { /* next packaging layout */ }
  }
  if (!stored && !bundled) throw failure('A required coaching prompt is unavailable.', 503);
  return stored && stored !== bundled ? `${stored}\n\n${bundled || ''}` : bundled || stored;
}
export async function collectLessonEnrichments(userId, lesson, lessonKB, telemetry) {
  let timer;
  try {
    return await Promise.race([
      withInferenceContext(inferenceContext(userId, { ...telemetry, lessonId: lesson.lessonId, agentRole: 'lesson-enrichment' }), () => emit('lessonStarted', { userId, lessonId: lesson.lessonId, lesson, lessonKB })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 30000); }),
    ]) || [];
  } catch { logger.warn('lesson_enrichment_unavailable', {}); return []; }
  finally { clearTimeout(timer); }
}
export async function recoverCoachTurn(userId, lessonId, turnId) {
  const turn = await readCoachResult(userId, lessonId);
  if (!turn || (turnId && turn.turnId !== turnId)) return null;
  const state = await db.getLessonState(userId, lessonId);
  return state.generation === turn.base.generation ? turn : null;
}
function validateInput(input) {
  if (!idPattern.test(input?.turnId || '') || !['start', 'send'].includes(input.kind) || !input.base) throw failure('Invalid coaching request.');
  if (input.kind === 'start') return { text: '', links: [], imageKeys: [] };
  const { text = '', links = [], imageKeys = [] } = input.submission || {};
  if (typeof text !== 'string' || text.length > 30000 || !Array.isArray(links) || links.length > 4 || !Array.isArray(imageKeys) || imageKeys.length > 4
    || imageKeys.some(key => typeof key !== 'string' || key.length > 200)
    || links.some(link => typeof link?.url !== 'string' || link.url.length > 2048 || !/^https?:\/\//i.test(link.url) || typeof link.text !== 'string' || link.text.length > 100000)
    || (!text.trim() && !links.length && !imageKeys.length)) throw failure('Invalid learner submission.');
  return { text, links, imageKeys };
}
async function generate(userId, lessonId, input, onText) {
  receiptKey();
  const submission = validateInput(input);
  const lesson = await resolveCoachLesson(userId, lessonId);
  const cached = await recoverCoachTurn(userId, lessonId, input.turnId);
  if (cached) return cached;
  const base = await db.getLessonState(userId, lessonId);
  if (!isDeepStrictEqual(base, input.base)) throw failure('This lesson changed. Reload the saved conversation before generating a reply.', 409);
  const opening = input.kind === 'start';
  if (opening ? base.messages.data.length > 0 : !base.lessonKB.data) throw failure('Reload the saved conversation before continuing.', 409);
  const { turnId } = input;
  // Register never-committed openings before inference so clear-all can fence
  // their eventual replies. One small server-owned marker per lesson.
  await db.putSyncData(userId, `coachAttempt:${lessonId}`, { turnId, generation: base.generation });
  const telemetry = { lessonId, turnId, generation: base.generation };
  const [profile, preferences, user] = await Promise.all([db.getSyncData(userId, 'profileSummary'), db.getSyncData(userId, 'preferences'), db.getUserById(userId)]);
  const criteriaHash = lessonCriteriaHash(lesson);
  let kb = structuredClone(base.lessonKB.data);
  if (opening) {
    const body = { system: await loadCoachPrompt('lesson-owner'), max_tokens: 2048, messages: [{ role: 'user', content: JSON.stringify({ lessonId, lessonName: lesson.name, lessonDescription: lesson.description, exemplar: lesson.exemplar, learningObjectives: lesson.learningObjectives, coachDirective: lesson.coachDirective || '', learnerProfile: profile?.data || 'New learner.' }) }] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await ai.invoke(LLM, body, { context: inferenceContext(userId, { ...telemetry, agentRole: 'lesson-owner' }) });
      try { kb = JSON.parse(response.content.filter(item => item.type === 'text').map(item => item.text).join('').replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { kb = null; }
      if (!validateLessonKB(kb, lesson)) break;
      if (attempt === 1) throw failure('Lesson initialization could not preserve the authored criteria. Please retry.', 502);
    }
    kb = { ...kb, lessonId, name: lesson.name, startedAt: Date.now(), progress: 0 };
    kb.enrichments = await collectLessonEnrichments(userId, lesson, kb, telemetry);
  }
  const wasCompleted = kb.status === 'completed';
  if (!wasCompleted) {
    if (kb.assessmentVersion !== 1 || kb.criteriaHash !== criteriaHash) kb = { ...kb, evidence: [], exemplarEvidence: empty(), sources: [], progress: 0, insights: [], learnerPosition: 'Assessment needs evidence against the current authored criteria.' };
    kb = reconcileLessonKB(lesson, kb);
    kb.criteriaHash = criteriaHash;
    delete kb.assessmentReviewRequired;
    kb.assessmentVersion = 1;
    kb.lessonOrigin = lesson.origin;
  }
  let sources = submissionSources({ turnId, ...submission });
  const sourceImages = new Map();
  const priorSources = kb.sources || [];
  for (const source of [...priorSources, ...sources].filter(item => item.kind === 'image')) {
    const url = (await db.getSyncData(userId, `screenshot:${source.imageKey}`))?.data;
    const match = typeof url === 'string' && url.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (match && (!source.contentHash || source.contentHash === digest(url))) {
      source.contentHash = digest(url);
      source.contentUnchanged = true;
      source.available = true;
      sourceImages.set(source.id, { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
    } else { source.available = false; source.contentUnchanged = false; }
  }
  const suppliedImages = [...sourceImages].slice(-4);
  const visibleIds = new Set(suppliedImages.map(([id]) => id));
  for (const source of [...priorSources, ...sources]) if (source.kind === 'image') source.available = visibleIds.has(source.id);
  sources = retainSources([], sources);
  kb = { ...kb, sources: retainSources(priorSources, sources, sourceIdsForEvidence(kb)) };
  // Only verified assistant turns are conversation context. Legacy user text
  // remains useful to orient coaching, but cannot invent source identifiers.
  const history = base.messages.data.slice(-40).filter(item => item.role === 'user' || item.assessmentProvenance === 'server-v1')
    .filter(item => typeof item.content === 'string' && item.content.trim()).map(item => ({ role: item.role, content: item.content.slice(0, 6000) }));
  const courseProgress = lesson.course ? (await db.getSyncData(userId, `courseProgress:${lesson.course.id}`))?.data?.summary : null;
  const context = buildContext(lesson, kb, profile?.data, preferences?.data?.name || user?.name || '', courseProgress);
  const parts = [{ type: 'text', text: opening ? 'Start the lesson.' : JSON.stringify({ learnerSubmission: submission.text || '(See attached sources)', currentSourceIds: sources.map(source => source.id) }) }];
  // Rehydrate retained images, bounded to four, including later confirmation.
  for (const [id, part] of suppliedImages) parts.push({ type: 'text', text: `Reference image source ${id}` }, part);
  const program = (await db.getSyncData('_system', 'knowledgeBase'))?.data?.content || '';
  const catalog = (await db.getAllSyncData('_system')).filter(item => item.dataKey.startsWith('lesson:') && (normalizeStatus(item.data?.status, !!item.data?.markdown) === 'public' || item.data?.sharedWith?.includes(userId)))
    .slice(0, 100).map(item => ({ lessonId: item.dataKey.slice(7), name: item.data.name || parseLessonPrompt('', item.data.markdown || '').name }));
  const body = { system: `${await loadCoachPrompt('coach')}\n\nUntrusted program reference data:\n${JSON.stringify({ knowledgeBase: program.slice(0, 16000), accessibleLessons: catalog })}`, max_tokens: 3072,
    messages: [{ role: 'user', content: context }, { role: 'assistant', content: 'Ready.' }, ...history, { role: 'user', content: parts }] };
  let raw = '';
  for await (const event of ai.invokeStream(LLM, body, { context: inferenceContext(userId, { ...telemetry, agentRole: 'coach' }) })) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') { raw += event.delta.text; await onText?.(visibleCoachText(raw, { partial: true })); }
  }
  const assessed = await assessCoachResponse(raw, body, async repairBody => {
    const response = await ai.invoke(LLM, repairBody, { context: inferenceContext(userId, { ...telemetry, agentRole: 'coach-assessment-repair' }) });
    return response.content.filter(item => item.type === 'text').map(item => item.text).join('');
  }, { opening, lessonKB: kb });
  const { parsed } = assessed;
  if (!parsed.text) throw failure('The coach returned no readable reply. Your submission is retained.', 502);
  const applied = applyCoachResponseToKB(kb, parsed, { opening, sources, submissionId: `${turnId}:0` });
  const phase = applied.phase;
  const messages = [];
  const metadata = submission.imageKeys.length || submission.links.length ? {
    ...(submission.imageKeys.length ? { imageKeys: submission.imageKeys } : {}),
    ...(submission.links.length ? { links: submission.links.map(({ url, title }) => ({ url, title: title || url })) } : {}),
  } : null;
  if (!opening) messages.push({ id: `${turnId}:0`, role: 'user', content: submission.text || (submission.imageKeys.length ? '[image]' : '[link]'), msgType: 'user', phase,
    metadata, timestamp: Date.now(), assessmentProvenance: 'server-v1' });
  messages.push({ id: `${turnId}:${messages.length}`, role: 'assistant', content: parsed.text, msgType: 'guide', phase, timestamp: Date.now(), assessmentProvenance: 'server-v1' });
  // Store bounded enrichment exactly as presented, not arbitrary plugin payloads.
  applied.lessonKB.enrichments = JSON.parse(context).enrichmentContext || [];
  const turn = { userId, lessonId, turnId, base, messages, lessonKB: applied.lessonKB, phase, achieved: applied.achieved,
    assessmentRepair: assessed.repair,
    profileObservation: profileObservationForTurn(parsed, applied.lessonKB, { opening, completed: wasCompleted }) };
  turn.receipt = signCoachTurn(turn);
  // One recoverable result per lesson; save/reload never needs inference.
  await storeCoachResult(turn);
  logger.info('coach_assessment', { metadata_valid: parsed.valid, original_metadata_issues: assessed.repair.originalIssues, repair_attempted: assessed.repair.attempted, repair_succeeded: assessed.repair.succeeded, repair_method: assessed.repair.method, issues: applied.issues, response_type: parsed.valid ? parsed.kbUpdate.responseType : 'invalid', completed: applied.achieved });
  return turn;
}
export function generateCoachTurn(userId, lessonId, input, onText) {
  const key = JSON.stringify([userId, lessonId]);
  if (inflight.has(key)) throw failure('A coach reply is already being generated for this lesson.', 409);
  const promise = generate(userId, lessonId, input, onText).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
