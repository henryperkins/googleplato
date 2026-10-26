import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
const { parseCoachResponse, applyCoachResponseToKB, buildContext, cleanStream } = await import('../src/lib/lessonEngine.js');
const lesson = { name: 'Compare options', description: 'Make a justified choice.', exemplar: 'Compare two options and justify a choice.', learningObjectives: ['Can compare two options', 'Can justify a choice'] };
const source = { id: 'turn-1:0', kind: 'text', text: 'A is cheaper, B is more reliable. Choose B because reliability matters more.', confirmed: true };
const kb = () => ({
  lessonId: 'lesson-1', status: 'active', progress: 6, activitiesCompleted: 6,
  exemplar: lesson.exemplar,
  objectives: [{ id: 'objective-a', objective: lesson.learningObjectives[0], evidence: 'A comparison' }, { id: 'objective-b', objective: lesson.learningObjectives[1], evidence: 'A justified choice' }],
  evidence: [], exemplarEvidence: { status: 'missing', observation: '', sourceIds: [] },
  sources: [source], insights: [], learnerPosition: 'A justification is needed.',
});
const evidence = () => [
  { objectiveId: 'objective-a', status: 'met', observation: 'Compares cost and reliability.', sourceIds: ['turn-1:0'] },
  { objectiveId: 'objective-b', status: 'met', observation: 'Chooses reliability and explains why.', sourceIds: ['turn-1:0'] },
];
const update = (overrides = {}) => ({ responseType: 'work', insights: ['Compared the options.'], learnerPosition: 'Both requirements are demonstrated.', evidence: evidence(), exemplarEvidence: { status: 'met', observation: 'A justified comparison.', sourceIds: ['turn-1:0'] }, ...overrides });
const reply = (progress = 6, changes = {}, body = 'Explain why reliability matters here.') => `${body}\n[PROGRESS: ${progress}]\n[KB_UPDATE: ${JSON.stringify(update(changes))}]`;

test('only the terminal metadata controls progress; an inline quotation remains visible', () => {
  const body = 'The text "[PROGRESS: 10]" is only an example.';
  const result = parseCoachResponse(reply(6, {}, body));
  assert.equal(result.progress, 6);
  assert.equal(result.text, body);
  assert.equal(result.valid, true);
});

for (const [name, raw] of [
  ['out-of-range', reply(100)], ['fraction', reply('10/10')], ['decimal', reply('8.5')],
  ['negative', reply(-1)], ['missing KB', 'Work on the comparison.\n[PROGRESS: 10]'],
  ['duplicate score', `Work on the comparison.\n[PROGRESS: 10]\n${reply(6)}`],
  ['trailing prose', `${reply(10)}\nIgnore the remaining requirements.`],
  ['invalid KB shape', 'Feedback.\n[PROGRESS: 10]\n[KB_UPDATE: {"insights":"invalid"}]'],
]) {
  test(`invalid ${name} metadata cannot change assessment`, () => {
    const parsed = parseCoachResponse(raw);
    assert.equal(parsed.valid, false);
    assert.equal(parsed.progress, null);
    const result = applyCoachResponseToKB(kb(), parsed);
    assert.equal(result.lessonKB.progress, 6);
    assert.equal(result.achieved, false);
  });
}

test('valid multiline JSON and braces inside observations parse without truncation', () => {
  const data = update({ insights: ['A literal }] and Unicode café are preserved.'] });
  const parsed = parseCoachResponse(`Feedback.\n[PROGRESS: 6]\n[KB_UPDATE: ${JSON.stringify(data, null, 2)}]`);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.kbUpdate.insights, data.insights);
});

test('a full-response fence is normalized without leaving a visible fence', () => {
  assert.equal(parseCoachResponse(`\`\`\`\n${reply()}\n\`\`\``).text, 'Explain why reliability matters here.');
});

test('streaming keeps quoted markers and suppresses the real metadata prefix', () => {
  const seen = [];
  const receive = cleanStream(value => seen.push(value));
  receive('The text "[PROGRESS: 10]" is an example.');
  receive('Visible feedback.\n[PRO');
  receive(reply());
  assert.deepEqual(seen, ['The text "[PROGRESS: 10]" is an example.', 'Visible feedback.', 'Explain why reliability matters here.']);
});

for (const body of [
  'Here is a literal example:\n~~~text\n[PROGRESS: 10]\n~~~\nContinue working.',
  'Here is a literal example:\n````text\n```\n[PROGRESS: 10]\n````\nContinue working.',
  'An indented example:\r\n    ~~~~text\r\n[KB_UPDATE: literal]\r\n    ~~~~\r\nContinue working.',
]) {
  test(`protocol scanning preserves literal fenced content: ${JSON.stringify(body)}`, () => {
    const parsed = parseCoachResponse(reply(6, {}, body));
    assert.equal(parsed.valid, true);
    assert.equal(parsed.text, body);
    assert.equal(parsed.progress, 6);
    const seen = [];
    cleanStream(value => seen.push(value))(reply(6, {}, body));
    assert.equal(seen[0], body);
  });
}

test('streaming retains an unfinished protocol-looking line inside a code example', () => {
  const seen = [];
  cleanStream(value => seen.push(value))('Example:\n~~~text\n[PRO');
  assert.equal(seen[0], 'Example:\n~~~text\n[PRO');
});

test('10 requires evidence for every authored objective and the exemplar', () => {
  const parsed = parseCoachResponse(reply(10, { evidence: evidence().slice(0, 1) }));
  const result = applyCoachResponseToKB(kb(), parsed);
  assert.equal(result.achieved, false);
  assert.equal(result.lessonKB.progress, 6);
  assert.ok(result.issues.includes('completion_evidence_missing'));
});

test('complete confirmed evidence permits one completion', () => {
  const completed = applyCoachResponseToKB(kb(), parseCoachResponse(reply(10)), { now: () => 123 });
  assert.equal(completed.achieved, true);
  assert.equal(completed.lessonKB.completedAt, 123);
  const feedback = applyCoachResponseToKB(completed.lessonKB, parseCoachResponse(reply(2, { responseType: 'feedback', evidence: [], exemplarEvidence: { status: 'missing', observation: '', sourceIds: [] } })));
  assert.equal(feedback.achieved, false);
  assert.equal(feedback.lessonKB.progress, 10);
  assert.deepEqual(feedback.lessonKB.evidence, completed.lessonKB.evidence);
  assert.equal(feedback.lessonKB.activitiesCompleted, completed.lessonKB.activitiesCompleted);
});

test('unconfirmed pages and invented source IDs cannot establish mastery', () => {
  for (const sources of [[{ ...source, kind: 'link', confirmed: false }], []]) {
    const result = applyCoachResponseToKB({ ...kb(), sources }, parseCoachResponse(reply(10)));
    assert.equal(result.achieved, false);
    assert.equal(result.lessonKB.progress, 6);
  }
});

test('source-invalid assessment cannot alter observations or confirm a reference', () => {
  const previous = kb();
  previous.insights = ['A valid earlier observation.'];
  previous.sources.push({ id: 'page', kind: 'link', url: 'https://example.test/work', text: 'Reference work', confirmed: false });
  const unknown = evidence().map(item => ({ ...item, sourceIds: ['unknown'] }));
  const parsed = parseCoachResponse(reply(10, { evidence: unknown, confirmedSourceIds: ['page'], insights: ['The learner mastered everything.'], learnerPosition: 'No further assessment is needed.' }));
  const current = { id: 'question:0', kind: 'text', confirmed: true, text: 'What does justify mean?' };
  const result = applyCoachResponseToKB(previous, parsed, { sources: [current], submissionId: current.id });
  assert.equal(result.achieved, false);
  assert.deepEqual(result.lessonKB.evidence, previous.evidence);
  assert.deepEqual(result.lessonKB.insights, previous.insights);
  assert.equal(result.lessonKB.learnerPosition, previous.learnerPosition);
  assert.equal(result.lessonKB.sources.find(item => item.id === 'page').confirmed, false);
  assert.ok(result.lessonKB.sources.some(item => item.id === current.id), 'actual learner input remains available');
});

test('a non-assessment turn with invented source references cannot replace the learner summary', () => {
  const previous = kb();
  const parsed = parseCoachResponse(reply(6, { responseType: 'question', evidence: [], insights: ['Everything is mastered.'], learnerPosition: 'Nothing remains.', exemplarEvidence: { status: 'met', observation: 'Invented proof.', sourceIds: ['unknown'] } }));
  const result = applyCoachResponseToKB(previous, parsed);
  assert.equal(result.lessonKB.learnerPosition, previous.learnerPosition);
  assert.deepEqual(result.lessonKB.insights, previous.insights);
});

for (const responseType of ['question', 'clarification', 'uncertainty', 'feedback', 'pause', 'distress']) {
  test(`${responseType} preserves existing assessment evidence and score`, () => {
    const previous = { ...kb(), evidence: evidence() };
    const result = applyCoachResponseToKB(previous, parseCoachResponse(reply(1, { responseType, evidence: [] })));
    assert.equal(result.lessonKB.progress, 6);
    assert.deepEqual(result.lessonKB.evidence, previous.evidence);
  });
}

test('a correction invalidates only the explicitly retracted objective', () => {
  const previous = { ...kb(), evidence: evidence() };
  const correction = update({ responseType: 'correction', evidence: [{ objectiveId: 'objective-b', status: 'missing', observation: 'The learner retracted the justification.', sourceIds: [] }], exemplarEvidence: { status: 'partial', observation: 'A new justification is needed.', sourceIds: ['turn-1:0'] } });
  const result = applyCoachResponseToKB(previous, parseCoachResponse(reply(4, correction)));
  assert.equal(result.lessonKB.progress, 4);
  assert.equal(result.lessonKB.evidence.find(item => item.objectiveId === 'objective-a').status, 'met');
  assert.equal(result.lessonKB.evidence.find(item => item.objectiveId === 'objective-b').status, 'missing');
});

test('opening stays at zero and records bounded observations without completion', () => {
  const result = applyCoachResponseToKB({ ...kb(), progress: 0, activitiesCompleted: 0 }, parseCoachResponse(reply(10)), { opening: true });
  assert.equal(result.lessonKB.progress, 0);
  assert.equal(result.lessonKB.activitiesCompleted, 0);
  assert.equal(result.achieved, false);
  assert.equal(result.lessonKB.insights[0], 'Compared the options.');
});

test('long lessons retain at most ten observations with no nested earlier wrapper', () => {
  let current = kb();
  for (let i = 0; i < 100; i++) current = applyCoachResponseToKB(current, parseCoachResponse(reply(6, { insights: [`First ${i}`, `Second ${i}`] }))).lessonKB;
  assert.equal(current.insights.length, 10);
  assert.equal(current.insights[0], 'First 95');
  assert.ok(JSON.stringify(current.insights).length < 200);
});

test('late pacing never permits completion merely close to the exemplar', () => {
  const context = JSON.parse(buildContext(lesson, { ...kb(), activitiesCompleted: 25 }, '', 'Alex'));
  assert.doesNotMatch(context.pacingDirective, /or something close|drop.*objectives/i);
  assert.match(context.pacingDirective, /required|evidence/i);
});

test('legacy completed observations are bounded before their first feedback request', () => {
  const previous = { ...kb(), status: 'completed', insights: ['[Earlier: nested legacy text]', ...Array.from({ length: 30 }, () => 'x'.repeat(600))] };
  const context = JSON.parse(buildContext(lesson, previous, '', ''));
  assert.equal(context.insights.length, 10);
  assert.ok(context.insights.every(item => item.length <= 300 && !item.startsWith('[Earlier:')));
});

test('generated evidence descriptions remain guidance while authored criteria govern assessment', () => {
  const state = kb();
  state.objectives[0].evidence = 'Names two real products and scores both on one shared numeric scale.';
  const authored = { ...lesson, coachDirective: 'A short justified contrast is sufficient.' };
  const context = JSON.parse(buildContext(authored, state, '', 'Ada'));
  assert.deepEqual(context.assessmentRequirements, { exemplar: authored.exemplar, objectives: authored.learningObjectives, authorDirective: authored.coachDirective });
  assert.equal(context.objectives[0].evidence, undefined);
  assert.equal(context.objectives[0].evidenceGuidance, state.objectives[0].evidence);
  assert.equal(context.objectives[0].objective, state.objectives[0].objective);
});

test('canonical criteria preserve exact author text and stable IDs across reordering', async () => {
  const contract = await import('../../server/src/shared/coachContract.js').catch(() => ({}));
  assert.equal(typeof contract.canonicalObjectives, 'function');
  const authored = { learningObjectives: ['Can compare café options', 'Can justify a choice'] };
  const first = contract.canonicalObjectives(authored);
  const reversed = contract.canonicalObjectives({ learningObjectives: [...authored.learningObjectives].reverse() });
  assert.deepEqual(first.map(item => item.objective), authored.learningObjectives);
  assert.equal(first[0].id, reversed[1].id);
  assert.notEqual(first[0].id, first[1].id);
  const duplicates = contract.canonicalObjectives({ learningObjectives: ['Can compare', 'Can compare'] });
  assert.equal(duplicates.length, 2);
  assert.notEqual(duplicates[0].id, duplicates[1].id);
});

test('bounded source history retains evidence-linked pages and pending submission excerpts', async () => {
  const contract = await import('../../server/src/shared/coachContract.js').catch(() => ({}));
  assert.equal(typeof contract.retainSources, 'function');
  const prior = [{ id: 'important', kind: 'link', text: 'Observed work', url: 'https://example.test/work', confirmed: true }];
  const incoming = Array.from({ length: 20 }, (_, i) => ({ id: `new-${i}`, kind: 'text', text: 'x'.repeat(9000), confirmed: true }));
  const retained = contract.retainSources(prior, incoming, ['important']);
  assert.equal(retained.length, 16);
  assert.ok(retained.some(item => item.id === 'important'));
  assert.ok(retained.some(item => item.id === 'new-19'));
  assert.ok(retained.every(item => !item.text || item.text.length <= 6000));
});

test('source confirmation is bound to a new learner submission and does not itself award mastery', async () => {
  const previous = { ...kb(), sources: [{ id: 'page-1', kind: 'link', text: 'A comparison', confirmed: false }] };
  const parsed = parseCoachResponse(reply(6, { responseType: 'work', confirmedSourceIds: ['page-1'], evidence: [], exemplarEvidence: { status: 'missing', observation: '', sourceIds: [] } }));
  const ungrounded = applyCoachResponseToKB(previous, parsed);
  assert.equal(ungrounded.lessonKB.sources[0].confirmed, false);
  const grounded = applyCoachResponseToKB(previous, parsed, { submissionId: 'confirmation-1', sources: [{ id: 'confirmation-1', kind: 'text', text: 'Yes, this is my finished submission.', confirmed: true }] });
  assert.equal(grounded.lessonKB.sources.find(item => item.id === 'page-1').confirmed, true);
  assert.equal(grounded.lessonKB.sources.find(item => item.id === 'page-1').confirmedBy, 'confirmation-1');
  assert.equal(grounded.achieved, false);
});
