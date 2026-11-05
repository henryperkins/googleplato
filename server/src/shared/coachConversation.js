import { visibleCoachText } from './coachProtocol.js';

const MAX_TEXT = 6000;
const MAX_LEGACY_BYTES = 48 * 1024;
const encoder = new TextEncoder();
export const TASK_CONFIRMATION_PROMPT = 'Please restate the task we should continue, including any website or link and constraints you want to keep. Start your reply with “Continue with:”.';
const usable = message => message && ['user', 'assistant'].includes(message.role)
  && typeof message.content === 'string' && message.content.trim();

function attachedLinks(message) {
  if (message.role !== 'user' || !Array.isArray(message.metadata?.links)) return {};
  const saved = message.metadata.links;
  const links = saved.flatMap(link => {
    if (typeof link?.url !== 'string' || link.url.length > 2048) return [];
    try { if (!['http:', 'https:'].includes(new URL(link.url).protocol)) return []; } catch { return []; }
    return [{ url: link.url, ...(typeof link.title === 'string' ? { title: link.title.slice(0, 300) } : {}) }];
  }).slice(0, 4);
  return { ...(links.length ? { links } : {}), ...(saved.length > links.length ? { linksIncomplete: true } : {}) };
}

function anchor(message) {
  if (!usable(message) || typeof message.id !== 'string' || !message.id || message.id.length > 160) return null;
  const text = message.role === 'assistant' ? visibleCoachText(message.content) : message.content.trim();
  if (!text) return null;
  return { sourceMessageId: message.id, role: message.role, text: text.slice(0, MAX_TEXT),
    provenance: message.role === 'user' ? 'learner' : message.assessmentProvenance === 'server-v1' ? 'server-v1' : 'legacy-unverified',
    ...attachedLinks(message),
    ...(text.length > MAX_TEXT ? { truncated: true } : {}) };
}

function boundedLegacyContext(anchors) {
  const retained = [];
  let bytes = 2; // JSON array brackets, plus a comma between each entry.
  for (let i = anchors.length - 1; i >= 0; i--) {
    const size = encoder.encode(JSON.stringify(anchors[i])).byteLength + (retained.length ? 1 : 0);
    if (bytes + size > MAX_LEGACY_BYTES) break;
    retained.push(anchors[i]);
    bytes += size;
  }
  return retained.reverse();
}

const completeRestatement = item => item?.role === 'user' && !item.truncated && !item.linksIncomplete
  && /^Continue with:\s*\S/i.test(item.text);

// Conversation anchors preserve what was asked, not what was demonstrated.
// Always rehydrate their exact text from saved messages; model summaries and
// legacy KB fields cannot invent a new assignment or evidence identifier.
export function reconcileConversationState(previous, messages = []) {
  const anchors = messages.map(anchor).filter(Boolean);
  const counts = new Map();
  for (const message of messages) {
    if (typeof message?.id === 'string') counts.set(message.id, (counts.get(message.id) || 0) + 1);
  }
  const byId = new Map(anchors.filter(item => counts.get(item.sourceMessageId) === 1).map(item => [item.sourceMessageId, item]));
  const selected = byId.get(previous?.assignment?.sourceMessageId);
  const opening = anchors.find(item => item.role === 'assistant');
  const assignment = counts.get(previous?.assignment?.sourceMessageId) > 1 ? null
    : selected?.role === 'assistant' ? selected : byId.get(opening?.sourceMessageId) || null;
  const previousDirections = Array.isArray(previous?.learnerDirections) ? previous.learnerDirections : [];
  const learnerDirections = previousDirections
    .map(item => byId.get(item?.sourceMessageId)).filter(item => item?.role === 'user');
  // Legacy transcripts have no reliable task-change markers. Preserve their
  // learner statements as chronological, unclassified context instead of
  // assuming the opening is still current or guessing intent from keywords.
  const legacyReferences = [2, 3].includes(previous?.version) && Array.isArray(previous.legacyLearnerContext)
    ? previous.legacyLearnerContext : anchors.filter(item => item.role === 'user');
  const legacyAnchors = [...new Map(legacyReferences.map(item => byId.get(item?.sourceMessageId))
    .filter(item => item?.role === 'user').map(item => [item.sourceMessageId, item])).values()];
  const confirmedTask = byId.get(previous?.confirmedTask?.sourceMessageId);
  const confirmed = completeRestatement(confirmedTask);
  const legacyLearnerContext = confirmed ? [] : boundedLegacyContext(legacyAnchors);
  const state = { version: 3, assignment,
    learnerDirections: [...new Map(learnerDirections.map(item => [item.sourceMessageId, item])).values()],
    legacyLearnerContext,
    latestCoachPrompt: byId.get(anchors.findLast(item => item.role === 'assistant')?.sourceMessageId) || null };
  if (confirmed) state.confirmedTask = confirmedTask;
  // Omitted history or incomplete task anchors can hide the active target.
  // Even a previously confirmed task cannot supersede a newer incomplete
  // direction: request a complete restatement before inference.
  const incomplete = item => item?.truncated || item?.linksIncomplete;
  const incompleteDirections = learnerDirections.some(incomplete)
    || previousDirections.some(item => byId.get(item?.sourceMessageId)?.role !== 'user');
  if (incompleteDirections || (!confirmed && (previous?.legacyContextTruncated || previous?.confirmedTask
    || incomplete(assignment) || legacyAnchors.some(incomplete)
    || legacyLearnerContext.length < legacyAnchors.length))) state.legacyContextTruncated = true;
  const confirmationPrompt = byId.get(previous?.confirmationPromptId);
  if (state.legacyContextTruncated && confirmationPrompt?.role === 'assistant'
    && confirmationPrompt.text === TASK_CONFIRMATION_PROMPT) state.confirmationPromptId = confirmationPrompt.sourceMessageId;
  if ([...counts.values()].some(count => count > 1)) state.sourceAmbiguity = true;
  if (previous?.correction?.reason === 'assignment-drift'
    && byId.get(previous.correction.afterMessageId)?.role === 'assistant'
    && byId.get(previous.correction.learnerMessageId)?.role === 'user') {
    state.correction = { reason: 'assignment-drift', afterMessageId: previous.correction.afterMessageId,
      learnerMessageId: previous.correction.learnerMessageId };
  }
  return state;
}

// Only an explicit reply to the server's saved clarification can replace the
// omitted historical task. A normal observation or attachment alone cannot.
export function confirmConversationTask(previous, message) {
  const item = anchor(message);
  if (!previous?.legacyContextTruncated || !previous.confirmationPromptId
    || previous.latestCoachPrompt?.sourceMessageId !== previous.confirmationPromptId
    || previous.latestCoachPrompt.text !== TASK_CONFIRMATION_PROMPT || !completeRestatement(item)) return previous;
  const state = { ...previous, confirmedTask: item, legacyLearnerContext: [], learnerDirections: [] };
  delete state.legacyContextTruncated;
  delete state.confirmationPromptId;
  return state;
}

export function applyConversationTurn(previous, messages, taskChangeSourceId) {
  const state = { ...previous, learnerDirections: [...(previous?.learnerDirections || [])] };
  for (const message of messages) {
    const item = anchor(message);
    if (!item) continue;
    if (message.role === 'assistant') {
      if (!state.sourceAmbiguity) state.assignment ||= item;
      state.latestCoachPrompt = item;
    } else if (message.id === taskChangeSourceId) {
      state.learnerDirections = [...state.learnerDirections.filter(entry => entry.sourceMessageId !== message.id), item];
    }
  }
  return state;
}

export function buildCoachHistory(messages = [], state) {
  if (state?.confirmedTask) {
    const start = messages.findIndex(message => message.id === state.confirmedTask.sourceMessageId);
    messages = start < 0 ? [] : messages.slice(start);
  }
  return messages.filter(usable).slice(-40).flatMap(message => {
    const text = message.role === 'assistant' ? visibleCoachText(message.content) : message.content.trim();
    if (!text) return [];
    if (message.role === 'assistant' && message.assessmentProvenance !== 'server-v1') {
      return [{ role: 'user', content: JSON.stringify({ unverifiedCoachMessage: {
        sourceMessageId: typeof message.id === 'string' ? message.id.slice(0, 160) : null,
        text: text.slice(0, MAX_TEXT), ...(text.length > MAX_TEXT ? { truncated: true } : {}),
      } }) }];
    }
    const attachments = attachedLinks(message);
    if (attachments.links || attachments.linksIncomplete) return [{ role: 'user', content: JSON.stringify({ learnerMessage: {
      text: text.slice(0, MAX_TEXT), ...attachments,
    } }) }];
    return [{ role: message.role, content: text.slice(0, MAX_TEXT) }];
  });
}
