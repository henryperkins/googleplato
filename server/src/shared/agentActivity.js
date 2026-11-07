// "Behind this response" (#411): which of plato's agents worked on a reply,
// what each read, and what it did. Built from what plato already parses out
// of agent output (progress, KB notes, profile observations, readiness), so
// it reports real effects, never the model's raw reasoning. Stored on the
// assistant message as `metadata.agents` and rendered by
// components/chat/AgentActivity.jsx. Unit tests: client/tests/agentActivity.test.js.

export const AGENT_LABELS = Object.freeze({
  coach: 'Coach',
  'lesson-owner': 'Lesson planner',
  'learner-profile-update': 'Learner profile',
  'course-progress-update': 'Unit progress',
  'lesson-creator': 'Lesson creator',
  'knowledge-base-editor': 'Knowledge base editor',
  plugins: 'Plugins',
});

const MAX_TEXT = 280;
const MAX_NOTES = 5;

const clip = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
};
const list = (arr) => (arr || []).map(clip).filter(Boolean);

/** One entry: `{ agent, label, read?, did?, notes? }`, empty lists dropped. */
export function entry(agent, { read, did, notes } = {}) {
  const e = { agent, label: AGENT_LABELS[agent] || agent };
  const r = list(read);
  const d = list(did);
  const n = list(notes).slice(0, MAX_NOTES);
  if (r.length) e.read = r;
  if (d.length) e.did = d;
  if (n.length) e.notes = n;
  return e;
}

/** What the authoring agents read on every turn (orchestrator.js appends the KB and catalog). */
export const AUTHORING_READS = ['Your conversation so far', 'The program knowledge base', 'The lesson catalog'];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function coachReads({ hasUnitNote, images = 0, links = 0 }) {
  return ['This lesson and its objectives', 'Your saved progress and conversation', 'Your learner profile summary',
    'The program knowledge base and accessible lesson catalog',
    ...(hasUnitNote ? ['What you did in other lessons of this unit'] : []),
    ...(images ? [`${plural(images, 'supplied image')}`] : []),
    ...(links ? [`${plural(links, 'readable linked page')}`] : [])];
}

export function coachTurnActivity({ before, after, achieved = false, newlyMet = [], images = 0, links = 0, hasUnitNote = false, assessmentRepair, profileObservation }) {
  const clarification = assessmentRepair?.method === 'continuity-clarification';
  const out = [entry('coach', {
    read: clarification ? [] : coachReads({ hasUnitNote, images, links }),
    did: [clarification ? 'Generated a continuity clarification from the saved conversation'
      : before?.status === 'completed' ? 'Gave feedback (the lesson was already complete)'
        : achieved ? 'Generated completion evidence; saving confirms the result'
          : `Progress ${before?.progress ?? 0} → ${after?.progress ?? 0} of 10`,
    ...newlyMet.map(o => `Recorded evidence for an objective: ${o}`),
    ...(assessmentRepair?.attempted ? [assessmentRepair.succeeded ? 'Repaired assessment metadata on the server' : 'Assessment repair failed; preserved the prior assessment'] : [])],
    notes: [...(after?.insights || []).slice(-2), ...(after?.learnerPosition ? [`Where you are: ${after.learnerPosition}`] : [])],
  })];
  if (profileObservation) out.push(entry('learner-profile-update', { did: ['Included a profile observation'], notes: [profileObservation.observation] }));
  return out;
}

export function lessonStartActivity({ lessonKB, enrichments = [], hasUnitNote = false, images = 0, links = 0 }) {
  const out = [entry('lesson-owner', { read: ['This lesson and its objectives', 'Your learner profile summary'],
    did: [`Planned how you'll show ${plural(lessonKB?.objectives?.length || 0, 'objective')}`],
    notes: lessonKB?.learnerPosition ? [`Where you are: ${lessonKB.learnerPosition}`] : [] })];
  if (enrichments.length) out.push(entry('plugins', { did: [`Added reference material: ${enrichments.map(e => e.source || e.label || e.pluginId || 'Reference').join(', ')}`] }));
  out.push(entry('coach', { read: coachReads({ hasUnitNote, images, links }), did: ['Opened the lesson'] }));
  return out;
}

/** An admin authoring turn (lesson creator, knowledge base editor). */
export function authoringActivity(agent, { before, after, reads }) {
  let did = null;
  if (typeof after === 'number') {
    did = typeof before === 'number' && before !== after ? `Readiness ${before} → ${after} of 10` : `Readiness ${after} of 10`;
  }
  return [entry(agent, { read: reads, did: [did] })];
}

/** "Coach, Learner profile": distinct labels, in order. */
export function activitySummary(agents) {
  return [...new Set((agents || []).map((a) => a.label))].join(', ');
}
