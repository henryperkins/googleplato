import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as evaluation from '../../scripts/evaluate-coach.js';
const { evaluateCoach, evaluateCoachReply } = evaluation;
import { coachFixtures } from '../../scripts/coach-fixtures.js';
test('fixed offline suite uses the production contract without any provider calls', async () => {
  const report = await evaluateCoach();
  assert.equal(report.calls, 0);
  assert.equal(report.results.length, 15);
  assert.equal(report.passed, true, JSON.stringify(report.results.filter(item => !item.passed)));
  assert.equal(report.identity.provider, null);
  assert.match(report.promptHash, /^[a-f0-9]{64}$/);
});
test('live evaluation requires an explicit bounded call budget before inference', async () => {
  await assert.rejects(evaluateCoach({ live: true, invoke: () => { throw new Error('must not call'); } }), /max-calls budget/);
  await assert.rejects(evaluateCoach({ trials: 6 }), /Trials/);
});
test('qualification detects a classifier error and unwarranted profile capture', () => {
  const fixture = coachFixtures.find(item => item.id === 'preserve-pause');
  const result = evaluateCoachReply(fixture, fixture.raw.replace('"pause"', '"work"') + '\n[PROFILE_UPDATE: {"observation":"Needs help","source":"learner_statement","kind":"constraint","sourceIds":["fixture:0"]}]');
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('response_type'));
  assert.ok(result.failures.includes('unwarranted_profile'));
});

test('live inputs expose the current answer as an identified source just like server coaching', () => {
  assert.equal(typeof evaluation.buildCoachEvaluationRequest, 'function');
  const fixture = coachFixtures.find(item => item.id === 'nearly-complete-nine');
  const body = evaluation.buildCoachEvaluationRequest(fixture, 'prompt');
  const context = JSON.parse(body.messages[0].content);
  assert.ok(context.sources.some(item => item.id === 'fixture:0' && item.text === fixture.input && item.confirmed));
  const current = JSON.parse(body.messages.at(-1).content);
  assert.equal(current.learnerSubmission, fixture.input);
  assert.ok(current.currentSourceIds.includes('fixture:0'));
});

test('opening and mid-lesson fixtures carry consistent counts and retained evidence', () => {
  const opening = coachFixtures.find(item => item.opening);
  assert.equal(opening.kb.activitiesCompleted, 0);
  assert.deepEqual(opening.kb.evidence, []);
  const paused = coachFixtures.find(item => item.id === 'preserve-pause');
  assert.ok(paused.kb.evidence.some(item => item.status === 'met'));
  assert.ok(paused.kb.evidence.every(item => item.sourceIds.every(id => paused.kb.sources.some(source => source.id === id))));
});

test('missing live metadata fails even when the defensive score remains unchanged', () => {
  const fixture = coachFixtures.find(item => item.id === 'preserve-question');
  const captured = 'Justify means explaining why a choice fits your situation. Which option would you choose?';
  const result = evaluateCoachReply(fixture, captured, { live: true });
  assert.equal(result.progress, fixture.kb.progress);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('protocol'));
});

test('equivalent progress-preserving labels pass while assessment labels cannot replace a question', () => {
  const fixture = coachFixtures.find(item => item.id === 'preserve-clarification');
  const equivalent = fixture.raw.replace('"clarification"', '"question"').replace('[PROGRESS: 10]', '[PROGRESS: 6]');
  assert.equal(evaluateCoachReply(fixture, equivalent, { live: true }).passed, true);
  const unsafe = equivalent.replace('"question"', '"work"');
  assert.ok(evaluateCoachReply(fixture, unsafe, { live: true }).failures.includes('response_type'));
});

test('unconfirmed-reference grading checks preserved assessment and ownership across label variants', () => {
  const fixture = coachFixtures.find(item => item.id === 'reference-injection');
  const update = { responseType: 'work', insights: [], learnerPosition: fixture.kb.learnerPosition, evidence: [], exemplarEvidence: fixture.kb.exemplarEvidence };
  const raw = data => `This reference does not demonstrate your choice.\n[PROGRESS: 6]\n[KB_UPDATE: ${JSON.stringify(data)}]`;
  assert.equal(evaluateCoachReply(fixture, raw(update), { live: true }).passed, true);
  assert.ok(evaluateCoachReply(fixture, raw({ ...update, confirmedSourceIds: ['page'] }), { live: true }).failures.includes('unconfirmed_reference'));
});

test('live metadata repair counts against the call budget and retains its original response', async () => {
  const fixture = coachFixtures.find(item => item.id === 'preserve-question');
  const visible = 'A justification is a reason for choosing. What matters most?';
  const repairedKB = { responseType: 'question', insights: [], learnerPosition: fixture.kb.learnerPosition, evidence: [], exemplarEvidence: fixture.kb.exemplarEvidence };
  const report = await evaluateCoach({ live: true, caseIds: [fixture.id], maxCalls: 2,
    invoke: async () => visible, invokeRepair: async () => JSON.stringify({ progress: 6, kbUpdate: repairedKB }) });
  assert.equal(report.calls, 2);
  assert.equal(report.passed, true);
  assert.equal(report.results[0].originalRawReply, visible);
  assert.equal(report.results[0].visibleReply, visible);
  assert.equal(report.results[0].metadataRepair.succeeded, true);
  const exhausted = await evaluateCoach({ live: true, caseIds: [fixture.id], maxCalls: 1, invoke: async () => visible });
  assert.equal(exhausted.calls, 1);
  assert.equal(exhausted.state, 'budget-exhausted');
  assert.equal(exhausted.passed, false);
});

test('a targeted live evaluation retains raw metadata, provider usage and progress after each call', async () => {
  const fixture = coachFixtures.find(item => item.id === 'preserve-pause');
  let calls = 0;
  const updates = [];
  const report = await evaluateCoach({ live: true, caseIds: [fixture.id], maxCalls: 1,
    identity: { provider: 'test', model: 'fixture-model' },
    invoke: async () => { calls++; return { raw: fixture.raw, usage: { input_tokens: 10, output_tokens: 20 }, stopReason: 'end_turn' }; },
    onUpdate: async report => updates.push(structuredClone(report)),
  });
  assert.equal(calls, 1);
  assert.equal(report.calls, 1);
  assert.equal(report.state, 'complete');
  assert.equal(report.results[0].rawReply, fixture.raw);
  assert.deepEqual(report.results[0].usage, { input_tokens: 10, output_tokens: 20 });
  assert.equal(report.results[0].reportedResponseType, 'pause');
  assert.ok(updates.some(item => item.results.length === 1));
});

test('a provider failure preserves earlier synthetic replies and stops the live batch', async () => {
  const fixture = coachFixtures.find(item => item.id === 'preserve-pause');
  let calls = 0;
  const report = await evaluateCoach({ live: true, caseIds: [fixture.id, 'preserve-distress'], maxCalls: 2,
    invoke: async () => { if (++calls === 1) return fixture.raw; throw Object.assign(new Error('Private provider details'), { name: 'WorkersAiError', httpStatus: 503 }); },
  });
  assert.equal(report.state, 'provider-error');
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].rawReply, fixture.raw);
  assert.ok(report.results[1].failures.includes('provider_error'));
  assert.doesNotMatch(JSON.stringify(report), /Private provider details/);
});
