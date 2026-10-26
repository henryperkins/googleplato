import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLessonKB } from '../js/validators.js';
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const orchestration = await import('../js/orchestrator.js');
const lesson = { exemplar: 'Compare café options.', learningObjectives: ['Can compare A', 'Can justify B'] };
const valid = () => ({ exemplar: lesson.exemplar, objectives: lesson.learningObjectives.map(objective => ({ objective, evidence: 'An observable example.' })), learnerPosition: 'No submitted evidence yet.', activitiesCompleted: 0, status: 'active', insights: [] });
test('initialization preserves every authored criterion exactly', () => {
  assert.equal(validateLessonKB(valid(), lesson), null);
  for (const changed of [ { exemplar: 'Different goal' }, { objectives: valid().objectives.slice(0, 1) },
    { objectives: valid().objectives.map(item => ({ ...item, objective: item.objective.toLowerCase() })) },
    { activitiesCompleted: 1 }, { status: 'completed' } ]) {
    assert.ok(validateLessonKB({ ...valid(), ...changed }, lesson));
  }
});
test('a second invalid owner response fails closed', async () => {
  assert.equal(typeof orchestration.callWithValidation, 'function');
  let calls = 0;
  await assert.rejects(orchestration.callWithValidation(async () => { calls++; return {}; }, () => 'Missing criteria.'), /Missing criteria/);
  assert.equal(calls, 2);
});
test('completion profile payload excludes raw sources, incidental disclosures and feedback', () => {
  assert.equal(typeof orchestration.completionEvidenceForProfile, 'function');
  assert.deepEqual(orchestration.completionEvidenceForProfile({ objectives: [{ id: 'a', objective: 'Can compare' }], evidence: [{ objectiveId: 'a', status: 'met' }], insights: ['private disclosure'], sources: [{ text: 'private disclosure' }], learnerPosition: 'feedback' }), { demonstratedObjectives: ['Can compare'] });
});
