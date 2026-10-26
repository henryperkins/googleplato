/**
 * Course completion counts on the learner's lesson list (#395).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { courseCompletion, groupByCourse } from '../src/lib/courseCompletion.js';

const A = { id: 'c_a', name: 'Alpha' };
const B = { id: 'c_b', name: 'Beta' };
const lessons = [
  { lessonId: 'a1', course: A, status: 'public' }, { lessonId: 'a2', course: A, status: 'public' }, { lessonId: 'a3', course: A, status: 'public' },
  { lessonId: 'b1', course: B, status: 'public' },
  { lessonId: 'custom-x', course: A, status: 'public' },
  { lessonId: 'loose', status: 'public' },
];
const data = { a1: { status: 'completed' }, a2: { status: 'active' }, b1: { status: 'completed' }, 'custom-x': { status: 'completed' } };

describe('courseCompletion', () => {
  it('counts completed / total per course', () => {
    assert.deepEqual(courseCompletion(lessons, data), { c_a: { completed: 1, total: 3 }, c_b: { completed: 1, total: 1 } });
  });

  it('excludes custom lessons and lessons without a course', () => {
    const c = courseCompletion(lessons, data);
    assert.equal(c.c_a.total, 3, 'custom-x not counted');
    assert.equal(Object.keys(c).length, 2, 'no bucket for course-less lessons');
  });

  it('does not depend on which lessons are visible', () => {
    // The page passes ALL lessons, so filtering the grid can't change the counts.
    const notStarted = lessons.filter((l) => !data[l.lessonId]);
    assert.deepEqual(courseCompletion(lessons, data).c_a, { completed: 1, total: 3 });
    assert.notDeepEqual(courseCompletion(notStarted, data).c_a, courseCompletion(lessons, data).c_a);
  });

  it('excludes private shared lessons and unconfirmed visibility from both counts', () => {
    const excluded = ['private', 'draft', 'published', undefined, null, 'unknown'].map((status, index) => ({
      lessonId: `excluded-${index}`, course: A, status,
    }));
    const completions = Object.fromEntries(excluded.map(lesson => [lesson.lessonId, { status: 'completed' }]));
    assert.deepEqual(courseCompletion([...lessons, ...excluded], { ...data, ...completions }), {
      c_a: { completed: 1, total: 3 }, c_b: { completed: 1, total: 1 },
    });
  });

  it('has no progress entry for a course containing only private shared lessons', () => {
    assert.deepEqual(courseCompletion([{ lessonId: 'private', course: A, status: 'private' }], {
      private: { status: 'completed' },
    }), {});
  });

  it('removes a completed lesson from both counts when it becomes private', () => {
    const updated = lessons.map(lesson => lesson.lessonId === 'a1' ? { ...lesson, status: 'private' } : lesson);
    assert.deepEqual(courseCompletion(updated, data).c_a, { completed: 0, total: 2 });
  });
});

describe('groupByCourse', () => {
  it('groups a sorted list by course', () => {
    const groups = groupByCourse([lessons[0], lessons[1], lessons[3], lessons[5]]);
    assert.deepEqual(groups.map((g) => [g.courseId, g.courseName, g.lessons.length]), [
      ['c_a', 'Alpha', 2], ['c_b', 'Beta', 1], [null, null, 1],
    ]);
  });

  it('is empty for no lessons', () => {
    assert.deepEqual(groupByCourse([]), []);
  });

  it('groups an uncategorized-only view without requiring a course header', () => {
    assert.deepEqual(groupByCourse([lessons[5]]), [{ courseId: null, courseName: null, lessons: [lessons[5]] }]);
    assert.deepEqual(courseCompletion([lessons[5]], data), {});
  });

  it('keeps one group per course when equally sorted course names interleave lessons', () => {
    const first = { id: 'resume', name: 'Resume' };
    const second = { id: 'cv', name: 'Résumé' };
    const interleaved = [
      { lessonId: 'alpha', course: first },
      { lessonId: 'beta', course: second },
      { lessonId: 'gamma', course: first },
    ];
    assert.deepEqual(groupByCourse(interleaved), [
      { courseId: 'resume', courseName: 'Resume', lessons: [interleaved[0], interleaved[2]] },
      { courseId: 'cv', courseName: 'Résumé', lessons: [interleaved[1]] },
    ]);
  });
});
