import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStatus, publicLessonIds } from '../../src/lib/lesson-visibility.js';

describe('legacy lesson visibility', () => {
  it('treats missing status as public only when lesson markdown exists', () => {
    assert.equal(normalizeStatus(undefined, true), 'public');
    assert.equal(normalizeStatus(undefined, false), 'private');
    for (const status of [null, '', 'unknown', 'private']) {
      assert.equal(normalizeStatus(status, true), 'private');
    }
    assert.equal(normalizeStatus('draft', false), 'draft');
    assert.equal(normalizeStatus('draft', true), 'private');
  });

  it('includes legacy lessons in public progress counts without counting incomplete records', () => {
    const items = [
      { dataKey: 'lesson:seeded', data: { markdown: '# Seeded', isBuiltIn: true } },
      { dataKey: 'lesson:authored', data: { markdown: '# Authored' } },
      { dataKey: 'lesson:published', data: { markdown: '# Published', status: 'published' } },
      { dataKey: 'lesson:private', data: { markdown: '# Private', status: 'private', sharedWith: ['usr_1'] } },
      { dataKey: 'lesson:unknown', data: { markdown: '# Unknown', status: 'unknown' } },
      { dataKey: 'lesson:empty', data: { markdown: '' } },
      { dataKey: 'lesson:missing-data' },
      { dataKey: 'prompt:coach', data: { content: 'A prompt' } },
    ];
    assert.deepEqual([...publicLessonIds(items)], ['seeded', 'authored', 'published']);
  });
});
