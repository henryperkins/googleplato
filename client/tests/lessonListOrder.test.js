/**
 * Order and grouping of the learner's lesson list: lessons in progress lead
 * the whole list, ahead of the course groups and pagination, and a learner
 * who has started nothing gets one Start here lesson.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupLessonsForPage, isInProgress, needsOtherHeading, orderLessons, startHereLessonId } from '../src/lib/lessonListOrder.js';
import { _populateCache, clearCache, getCachedLessonKB } from '../js/storage.js';

const A = { id: 'c_a', name: 'Alpha' };
const B = { id: 'c_b', name: 'Beta' };
const lesson = (lessonId, name, course) => ({ lessonId, name, ...(course ? { course } : {}) });
const ids = (list) => list.map((l) => l.lessonId);

const lessons = [
  lesson('b2', 'Beta two', B),
  lesson('loose', 'Loose end'),
  lesson('a10', 'Lesson 10', A),
  lesson('a2', 'Lesson 2', A),
  lesson('b1', 'Beta one', B),
];

describe('isInProgress', () => {
  it('is true only for a started, uncompleted lesson', () => {
    assert.equal(isInProgress({ status: 'learning', progress: 4 }), true);
    assert.equal(isInProgress({ status: 'completed', progress: 10 }), false);
    assert.equal(isInProgress({ status: null, progress: null }), false);
    assert.equal(isInProgress(undefined), false);
  });
});

describe('orderLessons', () => {
  it('sorts by course, then lesson name with numeric collation, lessons without a course last', () => {
    assert.deepEqual(ids(orderLessons(lessons)), ['a2', 'a10', 'b1', 'b2', 'loose']);
  });

  it('leads with lessons in progress across courses, each part in catalog order', () => {
    const data = { b2: { status: 'learning' }, loose: { status: 'learning' }, a2: { status: 'completed' } };
    assert.deepEqual(ids(orderLessons(lessons, data, { inProgressFirst: true })), ['b2', 'loose', 'a2', 'a10', 'b1']);
  });

  it('keeps catalog order without inProgressFirst, or when nothing is in progress', () => {
    const data = { b2: { status: 'learning' } };
    assert.deepEqual(ids(orderLessons(lessons, data)), ['a2', 'a10', 'b1', 'b2', 'loose']);
    assert.deepEqual(ids(orderLessons(lessons, { a2: { status: 'completed' } }, { inProgressFirst: true })), ['a2', 'a10', 'b1', 'b2', 'loose']);
  });

  it('brings a lesson in progress onto the first page past a long earlier course', () => {
    // The critique's case: 14 lessons in the first course pushed a later
    // course's lesson in progress to page 2 of 12.
    const long = Array.from({ length: 14 }, (_, i) => lesson(`a${i}`, `Practice ${i}`, A));
    const later = lesson('b-status', 'Write a status update', B);
    const ordered = orderLessons([...long, later], { 'b-status': { status: 'learning', progress: 2 } }, { inProgressFirst: true });
    assert.equal(ordered.indexOf(later), 0);
  });

  it('does not reorder its input', () => {
    const input = lessons.slice();
    orderLessons(input, { b2: { status: 'learning' } }, { inProgressFirst: true });
    assert.deepEqual(input, lessons);
  });
});

describe('groupLessonsForPage', () => {
  const data = { b2: { status: 'learning' }, loose: { status: 'learning' } };

  it('puts an In progress group first, then courses in first-seen order, then lessons without a course', () => {
    const page = orderLessons([...lessons, lesson('loose2', 'Another loose')], data, { inProgressFirst: true });
    const groups = groupLessonsForPage(page, data, { inProgressFirst: true });
    assert.deepEqual(groups.map((g) => [g.kind, g.key, ids(g.lessons)]), [
      ['in-progress', 'in-progress', ['b2', 'loose']],
      ['course', 'course:c_a', ['a2', 'a10']],
      ['course', 'course:c_b', ['b1']],
      ['other', 'other', ['loose2']],
    ]);
  });

  it('groups by course alone without inProgressFirst', () => {
    const groups = groupLessonsForPage(orderLessons(lessons), data);
    assert.deepEqual(groups.map((g) => [g.kind, g.courseId, g.courseName]), [
      ['course', 'c_a', 'Alpha'], ['course', 'c_b', 'Beta'], ['other', null, null],
    ]);
  });

  it('is empty for no lessons', () => {
    assert.deepEqual(groupLessonsForPage([], data, { inProgressFirst: true }), []);
  });
});

describe('needsOtherHeading', () => {
  const loose = [lesson('x', 'X'), lesson('y', 'Y')];

  it('needs no heading when every lesson lacks a course and none is in progress', () => {
    assert.equal(needsOtherHeading(loose, {}, { inProgressFirst: true }), false);
  });

  it('needs a heading when the list also has a course group', () => {
    assert.equal(needsOtherHeading([...loose, lesson('a', 'A', A)]), true);
  });

  it('needs a heading when an In progress group leads the list', () => {
    const data = { x: { status: 'learning' } };
    assert.equal(needsOtherHeading(loose, data, { inProgressFirst: true }), true);
    assert.equal(needsOtherHeading(loose, data), false, 'no In progress group under a status filter');
  });
});

describe('startHereLessonId', () => {
  const ordered = orderLessons(lessons);
  const betaOnly = orderLessons(lessons.filter((l) => l.course?.id === 'c_b'));

  it('marks the first lesson in the list for a learner who has started nothing', () => {
    assert.equal(startHereLessonId(ordered, lessons), 'a2');
    // The page's status map has an entry for every lesson, null until started.
    const unstarted = Object.fromEntries(lessons.map((l) => [l.lessonId, { status: null, progress: null }]));
    assert.equal(startHereLessonId(ordered, lessons, unstarted), 'a2');
  });

  it('follows the filtered list, so a course filter suggests that course\'s first lesson', () => {
    assert.equal(startHereLessonId(betaOnly, lessons), 'b1');
  });

  it('marks nothing once any lesson has a status, including one the filter hides', () => {
    assert.equal(startHereLessonId(ordered, lessons, { b2: { status: 'learning', progress: 1 } }), null);
    assert.equal(startHereLessonId(ordered, lessons, { loose: { status: 'completed', progress: 10 } }), null);
    assert.equal(startHereLessonId(betaOnly, lessons, { a2: { status: 'completed', progress: 10 } }), null);
  });

  it('marks nothing in a list of one, where there is nothing to choose between, or an empty one', () => {
    assert.equal(startHereLessonId([lessons[1]], lessons), null);
    assert.equal(startHereLessonId([], lessons), null);
  });

  it('never suggests an admin\'s own custom lesson', () => {
    const withCustom = orderLessons([lesson('custom-draft', 'Aardvark draft', A), ...lessons]);
    assert.equal(withCustom[0].lessonId, 'custom-draft');
    assert.equal(startHereLessonId(withCustom, withCustom), 'a2');
  });
});

describe('getCachedLessonKB', () => {
  it('reads a cached progress record without a network read, undefined when absent', () => {
    clearCache();
    _populateCache('lessonKB:started', { status: 'learning', progress: 6 }, 1);
    assert.deepEqual(getCachedLessonKB('started'), { status: 'learning', progress: 6 });
    assert.equal(getCachedLessonKB('never-started'), undefined);
    clearCache();
  });
});

describe('LessonsList wiring', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pages/LessonsList.jsx'), 'utf8');

  it('orders from the verified progress snapshot', () => {
    assert.match(src, /useLessonListProgress\(state\.lessons,/);
    assert.match(src, /sortLessons\(result\)/);
    assert.match(src, /lessonStatusKey\(statuses\[l.lessonId\]\)/);
  });

  it('names hierarchy groups and retains the status filter', () => {
    assert.match(src, /'In progress'/);
    assert.match(src, /groupForDisplay\(visibleLessons\)/);
    assert.match(src, /group.program.name/);
    assert.match(src, /unitName.*lessons/);
    assert.match(src, /'Other lessons'/);
  });

  it('marks Start here from the filtered list, in the card and its accessible name', () => {
    assert.match(src, /startHereLessonId\(filtered, lessons, statuses\)/);
    assert.match(src, /startHere=\{lesson\.lessonId === startHereId\}/);
    assert.match(src, /<span className="sr-only">Open lesson <\/span>/);
    assert.match(src, /startHere \? 'Start here\. ' : ''/);
    assert.match(src, /\{startHere \? <StartHereMark \/> : <StatusIndicator progress=\{progress\} statusText=\{statusText\} \/>\}/);
  });

  it('gives the outline dialog the next step, named for the lesson status', () => {
    assert.match(src, /<Button onClick=\{onOpenLesson\}>\{openLabel\}<\/Button>/);
    assert.match(src, /'Open lesson'\s*:\s*progress\?\.status \? 'Continue lesson' : 'Start lesson'/);
  });
});
