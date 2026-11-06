import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coachTurnActivity, lessonStartActivity, authoringActivity, entry, activitySummary } from '../src/lib/agentActivity.js';

describe('truthful coaching activity', () => {
  it('reports accepted evidence and repair without claiming optional post-save models ran', () => {
    const agents = coachTurnActivity({ before: { progress: 2 }, after: { progress: 10, insights: ['Specific work'], learnerPosition: 'Demonstrated' }, achieved: true,
      newlyMet: ['Can explain'], assessmentRepair: { attempted: true, succeeded: true, method: 'model' } });
    assert.deepEqual(agents.map(a => a.agent), ['coach']);
    assert.match(agents[0].did.join(';'), /Generated completion evidence/);
    assert.match(agents[0].did.join(';'), /Repaired assessment metadata/);
    assert.doesNotMatch(JSON.stringify(agents), /Marked the lesson complete|Asked to update|Your learner profile"/);
  });
  it('uses only a sourced accepted profile observation, never general insights', () => {
    const input = { before: {}, after: { progress: 3, insights: ['General lesson note'] } };
    assert.equal(coachTurnActivity(input).length, 1);
    const agents = coachTurnActivity({ ...input, profileObservation: { observation: 'Prefers brief examples' } });
    assert.deepEqual(agents[1].notes, ['Prefers brief examples']);
    assert.deepEqual(agents[1].did, ['Included a profile observation']);
  });
  it('describes a continuity clarification without claiming model invocation', () => {
    const [activity] = coachTurnActivity({ before: { progress: 2 }, after: { progress: 2 }, assessmentRepair: { method: 'continuity-clarification' } });
    assert.match(activity.did[0], /continuity clarification/);
    assert.equal(activity.read, undefined);
  });
  it('describes actual supplied references and bounded notes', () => {
    const [activity] = coachTurnActivity({ before: {}, after: { progress: 2, insights: Array(9).fill('x'.repeat(400)) }, images: 1, links: 2, hasUnitNote: true });
    assert.ok(activity.read.includes('1 supplied image'));
    assert.ok(activity.read.includes('2 readable linked pages'));
    assert.ok(activity.notes.length > 0 && activity.notes.length <= 5);
    assert.ok(activity.notes.every(n => n.length <= 280));
  });
  it('names sanitized plugin sources at opening', () => {
    const agents = lessonStartActivity({ lessonKB: { objectives: [{}] }, enrichments: [{ source: 'Reference docs' }] });
    assert.deepEqual(agents.map(a => a.label), ['Lesson planner', 'Plugins', 'Coach']);
    assert.match(agents[1].did[0], /Reference docs/);
  });
});

describe('authoring activity', () => {
  it('preserves derived authoring readiness and distinct summaries', () => {
    assert.deepEqual(authoringActivity('lesson-creator', { before: 2, after: 4, reads: ['Conversation'] })[0].did, ['Readiness 2 → 4 of 10']);
    assert.equal(activitySummary([entry('coach'), entry('coach')]), 'Coach');
    assert.deepEqual(entry('coach', { did: [null, ''] }), { agent: 'coach', label: 'Coach' });
  });
});
