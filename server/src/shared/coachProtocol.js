// Pure wire contract, shared by the browser, server and evaluation runner.
export const RESPONSE_TYPES = ['opening', 'work', 'question', 'clarification', 'uncertainty', 'correction', 'feedback', 'pause', 'distress'];
const tags = ['PROGRESS', 'KB_UPDATE', 'PROFILE_UPDATE'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const list = (value, max, validate) => Array.isArray(value) && value.length <= max && value.every(validate);
const ids = value => list(value, 2, id => string(id, 160)) && new Set(value).size === value.length;

export function validEvidence(value, objective = false) {
  return object(value) && keys(value, ['objectiveId', 'status', 'observation', 'sourceIds'])
    && (!objective || string(value.objectiveId, 100))
    && ['missing', 'partial', 'met'].includes(value.status)
    && string(value.observation, 400, value.status === 'missing') && ids(value.sourceIds)
    && (value.status === 'missing' || (value.observation.trim().length > 0 && value.sourceIds.length > 0));
}

export function validProfileObservation(value) {
  return object(value) && keys(value, ['observation', 'source', 'kind', 'sourceIds'])
    && string(value.observation, 400) && ['learner_statement', 'demonstrated_pattern'].includes(value.source)
    && ['preference', 'goal', 'background', 'constraint', 'strength', 'correction'].includes(value.kind)
    && ids(value.sourceIds) && value.sourceIds.length > 0;
}

export function validKBUpdate(value) {
  return object(value) && keys(value, ['responseType', 'insights', 'learnerPosition', 'evidence', 'exemplarEvidence', 'confirmedSourceIds'])
    && RESPONSE_TYPES.includes(value.responseType)
    && list(value.insights, 2, item => string(item, 300))
    && string(value.learnerPosition, 1500)
    && list(value.evidence, 4, item => validEvidence(item, true))
    && new Set(value.evidence.map(item => item.objectiveId)).size === value.evidence.length
    && validEvidence(value.exemplarEvidence)
    && (value.confirmedSourceIds === undefined || list(value.confirmedSourceIds, 8, item => string(item, 160)));
}

function unwrap(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const fence = text.match(/^```(?:text|plaintext|markdown)?\s*\n([\s\S]*?)\n```$/);
  return fence ? fence[1].trim() : text;
}

// Only control markers at the beginning of an unfenced line are protocol.
// An inline quotation, blockquote, or lesson code example is ordinary prose.
function controlLines(text) {
  const matches = [];
  let offset = 0;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^\[(?:PROGRESS|KB_UPDATE|PROFILE_UPDATE)(?::|\s|\])/.test(line)) matches.push(offset);
    offset += line.length + 1;
  }
  return matches;
}

export function visibleCoachText(raw, { partial = false } = {}) {
  let text = unwrap(raw);
  // Suppress a model's full-response fence during streaming as well.
  if (partial) text = text.replace(/^```(?:text|plaintext|markdown)?\s*\n/, '');
  const [first] = controlLines(text);
  if (first !== undefined) text = text.slice(0, first);
  if (partial) {
    const newline = text.lastIndexOf('\n');
    const last = text.slice(newline + 1);
    if (last.startsWith('[') && tags.some(tag => `[${tag}:`.startsWith(last))) text = text.slice(0, Math.max(0, newline));
  }
  return text.trim();
}

function readJSON(text, start) {
  let depth = 0, quoted = false, escaped = false;
  if (text[start] !== '{') return null;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === '{') depth++;
    if (!quoted && char === '}' && --depth === 0) {
      try { return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }; }
      catch { return null; }
    }
  }
  return null;
}

export function parseCoachResponse(raw) {
  const text = unwrap(raw);
  const result = { text: visibleCoachText(text), progress: null, kbUpdate: null, profileUpdate: null, valid: false, issues: [] };
  const [first] = controlLines(text);
  const invalid = reason => { result.issues.push(reason); return result; };
  if (first === undefined) return invalid('missing_metadata');
  if (!result.text) return invalid('missing_message');
  let rest = text.slice(first);
  const progress = rest.match(/^\[PROGRESS:[ \t]*(0|[1-9]|10)\][ \t]*(?:\r?\n|$)/);
  if (!progress) return invalid('invalid_progress');
  const score = Number(progress[1]);
  rest = rest.slice(progress[0].length).trimStart();
  const readTag = name => {
    const prefix = `[${name}:`;
    if (!rest.startsWith(prefix)) return null;
    let start = prefix.length;
    while (/\s/.test(rest[start] || '') && start < rest.length) start++;
    const parsed = readJSON(rest, start);
    if (!parsed) return null;
    let end = parsed.end;
    while (/[ \t]/.test(rest[end] || '') && end < rest.length) end++;
    if (rest[end] !== ']') return null;
    end++;
    if (rest.slice(end).trim() && !/^[ \t]*\r?\n/.test(rest.slice(end))) return null;
    rest = rest.slice(end).trimStart();
    return parsed.value;
  };
  const kbUpdate = readTag('KB_UPDATE');
  if (!validKBUpdate(kbUpdate)) return invalid('invalid_kb_update');
  let profileUpdate = null;
  if (rest.startsWith('[PROFILE_UPDATE:')) {
    profileUpdate = readTag('PROFILE_UPDATE');
    if (!validProfileObservation(profileUpdate)) return invalid('invalid_profile_update');
  }
  if (rest.trim()) return invalid('unexpected_metadata');
  return { ...result, progress: score, kbUpdate, profileUpdate, valid: true };
}
