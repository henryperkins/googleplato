import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LESSON_CARD_EXIT_MS,
  LESSON_CARD_STAGGER_LIMIT,
  reconcileLessonCards,
  hasExitingLessonCards,
  pruneExitingLessonCards,
} from '../src/lib/lessonCardTransitions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');
const read = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

const lessonA = { lessonId: 'lesson-a', name: 'Alpha' };
const lessonB = { lessonId: 'lesson-b', name: 'Beta' };
const lessonC = { lessonId: 'lesson-c', name: 'Gamma' };

describe('lessonCardTransitions state reconciliation', () => {
  it('marks initial lessons as entering with sequential stagger indices', () => {
    const initial = reconcileLessonCards([], [lessonA, lessonB]);
    assert.deepEqual(initial, [
      { lesson: lessonA, state: 'entering', index: 0 },
      { lesson: lessonB, state: 'entering', index: 1 },
    ]);
    assert.equal(hasExitingLessonCards(initial), false);
  });

  it('keeps surviving cards entered, marks removed cards exiting, and adds new cards as entering', () => {
    const prev = reconcileLessonCards([], [lessonA, lessonB]);
    const next = reconcileLessonCards(prev, [lessonB, lessonC]);

    assert.equal(hasExitingLessonCards(next), true);
    assert.deepEqual(next, [
      { lesson: lessonA, state: 'exiting', index: 0 },
      { lesson: lessonB, state: 'entered', index: 0 },
      { lesson: lessonC, state: 'entering', index: 1 },
    ]);

    const pruned = pruneExitingLessonCards(next);
    assert.equal(hasExitingLessonCards(pruned), false);
    assert.deepEqual(pruned, [
      { lesson: lessonB, state: 'entered', index: 0 },
      { lesson: lessonC, state: 'entered', index: 1 },
    ]);
  });

  it('transitions back to entering if an exiting card is re-included before prune completes', () => {
    const prev = reconcileLessonCards([], [lessonA, lessonB]);
    const filteredOut = reconcileLessonCards(prev, [lessonB]);
    assert.equal(filteredOut[0].state, 'exiting');

    const restored = reconcileLessonCards(filteredOut, [lessonA, lessonB]);
    assert.equal(hasExitingLessonCards(restored), false);
    assert.deepEqual(restored, [
      { lesson: lessonA, state: 'entering', index: 0 },
      { lesson: lessonB, state: 'entered', index: 1 },
    ]);
  });

  it('preserves state when the visible lesson order is unchanged', () => {
    const settled = pruneExitingLessonCards(reconcileLessonCards([], [lessonA, lessonB]));
    const updatedLessonA = { ...lessonA, name: 'Alpha Updated' };
    const next = reconcileLessonCards(settled, [updatedLessonA, lessonB]);
    assert.deepEqual(next, [
      { lesson: updatedLessonA, state: 'entered', index: 0 },
      { lesson: lessonB, state: 'entered', index: 1 },
    ]);
  });

  it('exports bounded exit timing and stagger constants', () => {
    assert.ok(LESSON_CARD_EXIT_MS > 0 && LESSON_CARD_EXIT_MS <= 300);
    assert.ok(LESSON_CARD_STAGGER_LIMIT > 0 && LESSON_CARD_STAGGER_LIMIT <= 12);
  });
});

describe('lesson-card CSS and component animation contract', () => {
  it('defines entrance, exit, and reduced-motion animations in index.css', () => {
    const css = read('index.css');
    assert.match(css, /\.lesson-card-enter[\s\S]*?animation:\s*lesson-card-enter\s+\d+ms\s+var\(--motion-arrive\)/);
    assert.match(css, /\.lesson-card-exit[\s\S]*?animation:\s*lesson-card-exit\s+\d+ms/);
    assert.match(css, /@keyframes lesson-card-enter/);
    assert.match(css, /@keyframes lesson-card-exit/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.lesson-card-enter[\s\S]*?\.lesson-card-exit/);
  });

  it('wires lesson-card entrance and exit classes and data-state in LessonsList.jsx', () => {
    const listSrc = read('pages/LessonsList.jsx');
    assert.match(listSrc, /data-slot="lesson-card"/);
    assert.match(listSrc, /data-state=\{isExiting \? 'exiting' : state\}/);
    assert.match(listSrc, /lesson-card \$\{isExiting \? 'lesson-card-exit' : 'lesson-card-enter'\}/);
  });
});
