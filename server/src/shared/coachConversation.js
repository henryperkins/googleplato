import { visibleCoachText } from './coachProtocol.js';

const MAX_TEXT = 6000;
const usable = message => message && ['user', 'assistant'].includes(message.role)
  && typeof message.content === 'string' && message.content.trim();

function anchor(message) {
  if (!usable(message) || typeof message.id !== 'string' || !message.id || message.id.length > 160) return null;
  const text = message.role === 'assistant' ? visibleCoachText(message.content) : message.content.trim();
  if (!text) return null;
  return { sourceMessageId: message.id, role: message.role, text: text.slice(0, MAX_TEXT),
    provenance: message.role === 'user' ? 'learner' : message.assessmentProvenance === 'server-v1' ? 'server-v1' : 'legacy-unverified',
    ...(text.length > MAX_TEXT ? { truncated: true } : {}) };
}

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
  // Preserve earlier additive changes, including a target selected before later
  // format/scope directions. The existing whole-record save limit bounds state;
  // exceeding it must reject the save rather than silently forget active work.
  const state = { version: 1, assignment,
    learnerDirections: [...new Map(learnerDirections.map(item => [item.sourceMessageId, item])).values()],
    latestCoachPrompt: byId.get(anchors.findLast(item => item.role === 'assistant')?.sourceMessageId) || null };
  if ([...counts.values()].some(count => count > 1)) state.sourceAmbiguity = true;
  if (previous?.correction?.reason === 'assignment-drift'
    && byId.get(previous.correction.afterMessageId)?.role === 'assistant'
    && byId.get(previous.correction.learnerMessageId)?.role === 'user') {
    state.correction = { reason: 'assignment-drift', afterMessageId: previous.correction.afterMessageId,
      learnerMessageId: previous.correction.learnerMessageId };
  }
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

export function buildCoachHistory(messages = []) {
  return messages.filter(usable).slice(-40).flatMap(message => {
    const text = message.role === 'assistant' ? visibleCoachText(message.content) : message.content.trim();
    if (!text) return [];
    if (message.role === 'assistant' && message.assessmentProvenance !== 'server-v1') {
      return [{ role: 'user', content: JSON.stringify({ unverifiedCoachMessage: {
        sourceMessageId: typeof message.id === 'string' ? message.id.slice(0, 160) : null,
        text: text.slice(0, MAX_TEXT), ...(text.length > MAX_TEXT ? { truncated: true } : {}),
      } }) }];
    }
    return [{ role: message.role, content: text.slice(0, MAX_TEXT) }];
  });
}
