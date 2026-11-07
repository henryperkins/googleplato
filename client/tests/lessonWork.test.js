/**
 * Lesson work view helpers (#438, src/lib/lessonWork.js).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { objectiveStatuses, objectivesMetLabel, progressLabel, collectArtifacts, messageImageUrls } from '../src/lib/lessonWork.js';

const evidence = (objectiveId, status = 'met', sourceIds = ['s']) => ({ objectiveId, status, observation: 'Demonstrated', sourceIds });
const kb = (over = {}) => ({ status: 'active', assessmentVersion: 1, objectives: [{ id: 'a', objective: 'A' }, { id: 'b', objective: 'B' }], sources: [{ id: 's', kind: 'text', confirmed: true }], evidence: [evidence('b')], ...over });

describe('canonical objective checklist', () => {
  it('uses canonical IDs in authored order and permits correction', () => {
    assert.deepEqual(objectiveStatuses(kb()).map(o => o.met), [false, true]);
    assert.deepEqual(objectiveStatuses(kb({ evidence: [evidence('b', 'missing', [])] })).map(o => o.met), [false, false]);
    assert.equal(objectivesMetLabel(kb()), '1 of 2 objectives met');
    assert.equal(progressLabel(kb()), 'Progress (1 of 2 Objectives)');
  });
  it('requires validated confirmed evidence and suppresses stale criteria and legacy index claims', () => {
    for (const over of [
      { assessmentVersion: undefined, objectivesMet: [0, 1] },
      { assessmentReviewRequired: true }, { sources: [] },
      { evidence: [{ objectiveId: 'b', status: 'met', sourceIds: ['s'] }] },
      { sources: [{ id: 's', kind: 'link', confirmed: true, text: '' }] },
      { sources: [{ id: 's', kind: 'image', confirmed: true, available: false, contentUnchanged: false }] },
    ]) assert.deepEqual(objectiveStatuses(kb(over)).map(o => o.met), [false, false]);
    assert.equal(objectiveStatuses(kb({ sources: [{ id: 's', kind: 'image', confirmed: true, available: false, contentUnchanged: true }] }))[1].met, true);
  });
  it('keeps historical completed lessons frozen and falls back before initialization', () => {
    assert.deepEqual(objectiveStatuses(kb({ status: 'completed', assessmentVersion: undefined })).map(o => o.met), [true, true]);
    assert.deepEqual(objectiveStatuses(null, ['X']), [{ objective: 'X', met: false }]);
  });
});

describe('collectArtifacts', () => {
  it('lists the learner’s images (by key) and links, oldest first, skipping the coach', () => {
    const messages = [
      { role: 'assistant', metadata: { agents: [] } },
      { role: 'user', timestamp: 1, metadata: { imageKeys: ['screenshot:a', 'screenshot:b'] } },
      { role: 'user', timestamp: 2, metadata: { links: [{ url: 'https://x.org', title: 'X' }], imageDataUrls: ['data:1'] } },
      { role: 'user', timestamp: 3, metadata: null },
    ];
    assert.deepEqual(collectArtifacts(messages), [
      { kind: 'image', key: 'screenshot:a', dataUrl: null, at: 1 },
      { kind: 'image', key: 'screenshot:b', dataUrl: null, at: 1 },
      { kind: 'image', key: null, dataUrl: 'data:1', at: 2 },
      { kind: 'link', url: 'https://x.org', title: 'X', at: 2 },
    ]);
  });

  it('pairs keys and hydrated images by position, keeping a gap where one couldn’t load', () => {
    const messages = [{ role: 'user', timestamp: 4, metadata: { imageKeys: ['screenshot:a', 'screenshot:b'], imageDataUrls: [null, 'data:b'] } }];
    assert.deepEqual(collectArtifacts(messages), [
      { kind: 'image', key: 'screenshot:a', dataUrl: null, at: 4 },
      { kind: 'image', key: 'screenshot:b', dataUrl: 'data:b', at: 4 },
    ]);
  });

  it('includes the single imageDataUrl of messages from before multiple images, as the chat does', () => {
    const messages = [{ role: 'user', timestamp: 7, metadata: { imageDataUrl: 'data:legacy' } }];
    assert.deepEqual(collectArtifacts(messages), [{ kind: 'image', key: null, dataUrl: 'data:legacy', at: 7 }]);
    assert.deepEqual(messageImageUrls({ imageDataUrl: 'data:legacy' }), ['data:legacy']);
    assert.deepEqual(messageImageUrls({ imageDataUrls: ['data:new'], imageDataUrl: 'data:legacy' }), ['data:new']);
    assert.deepEqual(messageImageUrls(null), []);
  });
});
