import { evidenceIsMet } from '../../../server/src/shared/lessonAssessment.js';

/** A projection of canonical evidence; no client-owned progress accumulation. */
export function objectiveStatuses(kb, fallbackObjectives = []) {
  const objectives = kb?.objectives?.length ? kb.objectives : fallbackObjectives;
  return objectives.map(item => ({
    objective: typeof item === 'string' ? item : item.objective,
    met: kb?.status === 'completed' || (kb?.assessmentVersion === 1 && !kb.assessmentReviewRequired
      && typeof item === 'object' && !!item.id
      && evidenceIsMet(kb.evidence?.find(e => e.objectiveId === item.id), kb.sources)),
  })).map(item => ({ ...item, met: !!item.met }));
}

/** "N of M objectives met": the overview's checklist summary. */
export function objectivesMetLabel(kb, fallbackObjectives = []) {
  const list = objectiveStatuses(kb, fallbackObjectives);
  return `${list.filter((o) => o.met).length} of ${list.length} objectives met`;
}

/** "Progress (N of M Objectives)": the lesson header's button, which opens the overview. */
export function progressLabel(kb, fallbackObjectives = []) {
  const list = objectiveStatuses(kb, fallbackObjectives);
  return `Progress (${list.filter((o) => o.met).length} of ${list.length} Objectives)`;
}

/**
 * The learner's attachments in this lesson, oldest first:
 * `{ kind: 'image', key?, dataUrl?, at }` and `{ kind: 'link', url, title, at }`.
 * Images are referenced by `metadata.imageKeys` (fetched on demand); messages
 * hydrated this session also carry `imageDataUrls`.
 */
export function collectArtifacts(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role !== 'user' || !m.metadata) continue;
    const at = m.timestamp || null;
    const keys = Array.isArray(m.metadata.imageKeys) ? m.metadata.imageKeys : [];
    const urls = Array.isArray(m.metadata.imageDataUrls) ? m.metadata.imageDataUrls : [];
    const count = Math.max(keys.length, urls.length);
    for (let i = 0; i < count; i++) out.push({ kind: 'image', key: keys[i] || null, dataUrl: urls[i] || null, at });
    for (const l of Array.isArray(m.metadata.links) ? m.metadata.links : []) {
      if (/^https?:\/\//i.test(l?.url || '')) out.push({ kind: 'link', url: l.url, title: l.title || l.url, at });
    }
  }
  return out;
}
