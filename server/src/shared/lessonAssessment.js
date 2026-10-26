import { validEvidence } from './coachProtocol.js';

export const MAX_SOURCES = 16;
const clip = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const emptyEvidence = () => ({ status: 'missing', observation: '', sourceIds: [] });

// Identity is independent of order or learner profile. This is an identifier,
// not a security digest; receipts use SHA-256 on the complete authored input.
function objectiveId(text) {
  let hash = 2166136261;
  for (const char of text) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return `objective-${(hash >>> 0).toString(16)}`;
}

export function canonicalObjectives(lesson, previous = []) {
  const authored = lesson?.learningObjectives;
  if (!Array.isArray(authored) || authored.length < 1 || authored.length > 4
    || authored.some(value => typeof value !== 'string' || !value.trim() || value.length > 2000)) throw new Error('The lesson needs one to four authored objectives.');
  const occurrences = new Map();
  const result = authored.map(objective => {
    const occurrence = (occurrences.get(objective) || 0) + 1;
    occurrences.set(objective, occurrence);
    return { id: `${objectiveId(objective)}${occurrence === 1 ? '' : `-${occurrence}`}`, objective,
      evidence: clip(previous.find(item => item?.objective === objective)?.evidence || objective, 1000) };
  });
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error('The lesson objective identifiers conflict.');
  return result;
}

export function reconcileLessonKB(lesson, previous = {}) {
  const objectives = canonicalObjectives(lesson, previous.objectives || []);
  const allowed = new Set(objectives.map(item => item.id));
  const sameExemplar = previous.exemplar === lesson.exemplar;
  return { ...previous, exemplar: lesson.exemplar, objectives,
    evidence: (previous.evidence || []).filter(item => allowed.has(item?.objectiveId) && validEvidence(item, true)),
    exemplarEvidence: sameExemplar && validEvidence(previous.exemplarEvidence) ? previous.exemplarEvidence : emptyEvidence(),
    sources: retainSources(previous.sources, [], []),
    insights: boundedInsights(previous.insights),
  };
}

function boundedInsights(previous = [], incoming = []) {
  return [...(Array.isArray(previous) ? previous : []), ...incoming]
    .filter(item => typeof item === 'string' && !item.startsWith('[Earlier:'))
    .map(item => clip(item, 300)).slice(-10);
}

export function retainSources(previous = [], incoming = [], protectedIds = []) {
  const byId = new Map();
  for (const item of [...(Array.isArray(previous) ? previous : []), ...incoming]) {
    if (!item || typeof item.id !== 'string' || item.id.length > 160 || !['text', 'link', 'image'].includes(item.kind)) continue;
    const source = { id: item.id, kind: item.kind, confirmed: item.confirmed === true };
    for (const field of ['url', 'title', 'imageKey', 'confirmedBy', 'contentHash']) if (typeof item[field] === 'string') source[field] = clip(item[field], field === 'url' ? 2048 : 300);
    if (typeof item.available === 'boolean') source.available = item.available;
    if (typeof item.contentUnchanged === 'boolean') source.contentUnchanged = item.contentUnchanged;
    if (typeof item.text === 'string') { source.text = clip(item.text, 6000); source.truncated = item.truncated === true || item.text.length > 6000; }
    byId.set(source.id, source);
  }
  const all = [...byId.values()];
  const protectedSet = new Set(protectedIds);
  const protectedSources = all.filter(item => protectedSet.has(item.id)).slice(-MAX_SOURCES);
  const recent = all.filter(item => !protectedSet.has(item.id)).slice(-(MAX_SOURCES - protectedSources.length) || all.length);
  return [...protectedSources, ...(protectedSources.length === MAX_SOURCES ? [] : recent)].slice(-MAX_SOURCES);
}

export function sourceIdsForEvidence(kb) {
  return [...new Set([...(kb.evidence || []), kb.exemplarEvidence].flatMap(item => item?.sourceIds || []))];
}

export function submissionSources({ turnId, text = '', links = [], imageKeys = [] }) {
  const sources = [];
  if (text.trim()) sources.push({ id: `${turnId}:0`, kind: 'text', text, confirmed: true });
  links.forEach((link, index) => sources.push({ id: `${turnId}:0:link:${index}`, kind: 'link', url: link.url, title: link.title || link.url, text: link.text || '', confirmed: false }));
  imageKeys.forEach((imageKey, index) => sources.push({ id: `${turnId}:0:image:${index}`, kind: 'image', imageKey, confirmed: false }));
  return retainSources([], sources);
}

export function applyCoachResponseToKB(previous, parsed, { now = Date.now, opening = false, sources = [], submissionId } = {}) {
  const wasCompleted = previous?.status === 'completed';
  const next = { ...previous, insights: boundedInsights(previous?.insights) };
  const issues = [...(parsed.issues || [])];
  next.sources = retainSources(previous?.sources, sources, sourceIdsForEvidence(previous || {}));
  if (!wasCompleted) next.activitiesCompleted = opening ? 0 : (previous?.activitiesCompleted || 0) + 1;
  if (opening) next.progress = 0;
  if (!parsed.valid) return { lessonKB: next, achieved: false, phase: wasCompleted ? 'completed' : 'learning', issues };
  const update = parsed.kbUpdate;
  const validIds = new Set((previous.objectives || []).map(item => item.id));
  const available = new Set(next.sources.map(item => item.id));
  const referenced = [...(update.evidence || []), ...(update.exemplarEvidence ? [update.exemplarEvidence] : [])];
  if ((update.evidence || []).some(item => !validIds.has(item.objectiveId))
    || referenced.some(item => item.sourceIds.some(id => !available.has(id)))
    || update.confirmedSourceIds?.some(id => !available.has(id))) {
    issues.push('unknown_evidence_source');
    return { lessonKB: next, achieved: false, phase: wasCompleted ? 'completed' : 'learning', issues };
  }
  const observe = () => {
    next.insights = boundedInsights(next.insights, update.insights);
    next.learnerPosition = update.learnerPosition;
  };
  if (wasCompleted || opening) {
    observe();
    return { lessonKB: next, achieved: false, phase: wasCompleted ? 'completed' : 'learning', issues };
  }
  const assess = ['work', 'correction'].includes(update.responseType);
  const submission = sources.find(item => item.id === submissionId && item.kind === 'text' && item.text?.trim());
  if (!assess) {
    observe();
    return { lessonKB: next, achieved: false, phase: 'learning', issues };
  }

  const grounded = (entry, prior) => entry.sourceIds.every(id => {
    if (!available.has(id)) return false;
    const source = next.sources.find(item => item.id === id);
    // A new assessment cannot claim to see an omitted screenshot. Previously
    // met evidence may survive without resending pixels only if it is unchanged.
    return source.kind !== 'image' || source.available !== false
      || (source.contentUnchanged && prior?.status === 'met' && entry.status === 'met'
        && entry.observation === prior.observation && JSON.stringify(entry.sourceIds) === JSON.stringify(prior.sourceIds));
  });
  if (update.evidence.some(item => !validIds.has(item.objectiveId) || !grounded(item, previous.evidence?.find(prior => prior.objectiveId === item.objectiveId))) || !grounded(update.exemplarEvidence, previous.exemplarEvidence)
    || update.confirmedSourceIds?.some(id => !available.has(id))) {
    issues.push('unknown_evidence_source');
    return { lessonKB: next, achieved: false, phase: 'learning', issues };
  }
  if (submission) next.sources = next.sources.map(item => update.confirmedSourceIds?.includes(item.id)
    ? { ...item, confirmed: true, confirmedBy: submissionId } : item);
  observe();
  const evidence = new Map((previous.evidence || []).filter(item => validIds.has(item.objectiveId)).map(item => [item.objectiveId, item]));
  for (const item of update.evidence) evidence.set(item.objectiveId, { ...item, sourceIds: [...item.sourceIds] });
  next.evidence = [...evidence.values()];
  next.exemplarEvidence = { ...update.exemplarEvidence, sourceIds: [...update.exemplarEvidence.sourceIds] };
  const confirmed = new Set(next.sources.filter(item => item.confirmed && (item.available !== false || item.contentUnchanged) && (item.kind !== 'link' || item.text?.trim())).map(item => item.id));
  const met = item => item?.status === 'met' && item.sourceIds.length > 0 && item.sourceIds.every(id => confirmed.has(id));
  const achieved = parsed.progress === 10 && validIds.size > 0
    && [...validIds].every(id => met(evidence.get(id))) && met(next.exemplarEvidence);
  if (parsed.progress === 10 && !achieved) issues.push('completion_evidence_missing');
  else next.progress = parsed.progress;
  if (achieved) { next.status = 'completed'; next.completedAt = now(); }
  next.sources = retainSources(next.sources, [], sourceIdsForEvidence(next));
  return { lessonKB: next, achieved, phase: achieved ? 'completed' : 'learning', issues };
}

export function profileObservationForTurn(parsed, kb, { opening = false, completed = false } = {}) {
  const observation = parsed.valid && parsed.profileUpdate;
  if (!observation || opening || completed || ['feedback', 'pause', 'distress'].includes(parsed.kbUpdate.responseType)) return null;
  const known = new Set((kb.sources || []).filter(item => item.confirmed).map(item => item.id));
  return observation.sourceIds.every(id => known.has(id)) ? observation : null;
}
