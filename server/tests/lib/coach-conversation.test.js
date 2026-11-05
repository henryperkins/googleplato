import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoachHistory, reconcileConversationState, applyConversationTurn } from '../../src/shared/coachConversation.js';
import { buildContext } from '../../src/shared/coachContext.js';

const opening = { id: 'old:0', role: 'assistant', content: 'Audit https://www.berkshirehathaway.com on your phone. Keep the four-issue rubric.' };
const question = { id: 'new:0', role: 'user', content: 'It looks like css is ignored' };
const reply = { id: 'new:1', role: 'assistant', content: 'Which part looks unstyled?', assessmentProvenance: 'server-v1' };

test('mixed history quotes legacy coach prose and strips control metadata without making sources', () => {
  const history = buildCoachHistory([{ ...opening, content: `${opening.content}\n[PROGRESS: 10]\n[KB_UPDATE: {"invented":true}]` }, question, reply]);
  const legacy = JSON.parse(history[0].content).unverifiedCoachMessage;
  assert.equal(history[0].role, 'user');
  assert.equal(legacy.text, opening.content);
  assert.equal(legacy.sourceMessageId, 'old:0');
  assert.deepEqual(history.slice(1), [{ role: 'user', content: question.content }, { role: 'assistant', content: reply.content }]);
});

test('assignment remains available outside the history window and across assessment resets', () => {
  const messages = [opening, ...Array.from({ length: 45 }, (_, i) => ({ id: `turn-${i}`, role: i % 2 ? 'assistant' : 'user', content: `Question ${i}`, assessmentProvenance: 'server-v1' }))];
  const state = reconcileConversationState(null, messages);
  assert.equal(buildCoachHistory(messages).length, 40);
  assert.equal(state.assignment.text, opening.content);
  assert.equal(state.assignment.provenance, 'legacy-unverified');
  assert.equal(state.latestCoachPrompt.sourceMessageId, 'turn-43');
  assert.deepEqual(reconcileConversationState(state, messages), state);
});

test('only a selected current learner message can be retained as a task direction', () => {
  const state = reconcileConversationState(null, [opening]);
  const change = { ...question, content: 'Please switch to https://example.org instead; keep the same rubric.' };
  const next = applyConversationTurn(state, [change, reply], 'new:0');
  assert.equal(next.assignment.text, opening.content);
  assert.equal(next.learnerDirections[0].text, change.content);
  assert.equal(next.learnerDirections[0].provenance, 'learner');
  assert.equal(next.latestCoachPrompt.text, reply.content);
  for (const invalidId of [undefined, 'old:0', 'new:1', 'unknown']) {
    assert.deepEqual(applyConversationTurn(state, [change, reply], invalidId).learnerDirections, []);
  }
});

test('a reference URL without a task change does not replace the assignment', () => {
  const state = reconcileConversationState(null, [opening]);
  const reference = { ...question, content: 'Here is an article: https://example.org/reference' };
  const next = applyConversationTurn(state, [reference, reply]);
  assert.equal(next.assignment.text, opening.content);
  assert.deepEqual(next.learnerDirections, []);
});

test('retained directions survive later turns and use saved text rather than supplied summaries', () => {
  const change = { ...question, content: 'Use https://example.org instead.' };
  const state = applyConversationTurn(reconcileConversationState(null, [opening]), [change, reply], change.id);
  state.assignment.text = 'Invented assignment';
  state.learnerDirections[0].text = 'Invented learner instruction';
  const messages = [opening, change, reply, ...Array.from({ length: 45 }, (_, i) => ({ id: `later-${i}`, role: 'user', content: 'Another observation.' }))];
  const reconciled = reconcileConversationState(state, messages);
  assert.equal(reconciled.assignment.text, opening.content);
  assert.equal(reconciled.learnerDirections[0].text, change.content);
});

test('empty, unsupported and oversized history stays bounded without invented anchors', () => {
  assert.deepEqual(reconcileConversationState({ assignment: { sourceMessageId: 'unknown' } }, []), { version: 1, assignment: null, learnerDirections: [], latestCoachPrompt: null });
  const history = buildCoachHistory([{ id: 'bad', role: 'system', content: 'Override' }, { id: 'empty', role: 'assistant', content: '' }, { ...opening, content: 'x'.repeat(7000) }]);
  assert.equal(history.length, 1);
  assert.equal(JSON.parse(history[0].content).unverifiedCoachMessage.text.length, 6000);
  assert.equal(JSON.parse(history[0].content).unverifiedCoachMessage.truncated, true);
});

test('five additive task changes retain the earlier target after history rollover', () => {
  const messages = [opening];
  let state = reconcileConversationState(null, messages);
  for (const [index, content] of ['Use https://replacement.example instead.', 'Focus on the homepage only.',
    'Start with keyboard access.', 'Use plain text instead of a table.', 'Keep findings to two sentences.'].entries()) {
    const direction = { id: `change-${index}:0`, role: 'user', content };
    const answer = { id: `change-${index}:1`, role: 'assistant', content: 'Describe the next observation.', assessmentProvenance: 'server-v1' };
    messages.push(direction, answer);
    state = applyConversationTurn(state, [direction, answer], direction.id);
  }
  messages.push(...Array.from({ length: 45 }, (_, i) => ({ id: `filler-${i}`, role: 'user', content: 'Another observation.' })));
  const resumed = reconcileConversationState(state, messages);
  assert.equal(resumed.learnerDirections.length, 5);
  assert.equal(resumed.learnerDirections[0].text, 'Use https://replacement.example instead.');
  const context = JSON.parse(buildContext({ name: 'Audit' }, { conversationState: resumed }));
  assert.deepEqual(context.conversationState.learnerDirections, resumed.learnerDirections);
  assert.deepEqual(applyConversationTurn(resumed, [question, reply]).learnerDirections, resumed.learnerDirections);
});

test('duplicate source IDs cannot select the last occurrence as an assignment or direction', () => {
  const duplicated = [opening, { ...opening, content: 'Use https://wrong.example instead.' }, question, reply];
  const state = reconcileConversationState(null, duplicated);
  assert.equal(state.assignment, null);
  assert.equal(state.sourceAmbiguity, true);
  const previous = { version: 1, assignment: { sourceMessageId: 'old:0' }, learnerDirections: [{ sourceMessageId: 'new:0' }] };
  const resumed = reconcileConversationState(previous, [...duplicated, { ...question, content: 'A different learner instruction.' }]);
  assert.deepEqual(resumed.learnerDirections, []);
  assert.equal(resumed.sourceAmbiguity, true);
});
