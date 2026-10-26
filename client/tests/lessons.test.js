import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// The client (lessonOwner.js) and the server parse lessons with this one
// implementation, so test it rather than a copy that could drift.
import { parseLessonPrompt } from '../../server/src/shared/lessonMarkdown.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const lessonsDir = resolve(root, 'data', 'lessons');

// Load all lesson prompt files. The directory is optional — lesson seeding was
// removed in #288, so a clean checkout has no data/lessons at all. Reading it at
// import time would throw ENOENT and fail the whole file before any test runs.
const lessonFiles = existsSync(lessonsDir)
  ? readdirSync(lessonsDir).filter(f => f.endsWith('.md'))
  : [];
const lessons = lessonFiles.map(f => {
  const lessonId = f.replace('.md', '');
  const content = readFileSync(resolve(lessonsDir, f), 'utf8');
  return parseLessonPrompt(lessonId, content);
});

describe('lesson prompt files', () => {
  it('parses any lesson files that exist', () => {
    // Built-in lesson files are optional — lessons can be user-created via SQLite
    // This test validates the format of any .md files present
    for (const lesson of lessons) {
      assert.ok(lesson.lessonId, 'Parsed lesson has a lessonId');
    }
  });

  it('every lesson has required fields', () => {
    for (const lesson of lessons) {
      assert.ok(lesson.lessonId && typeof lesson.lessonId === 'string',
        `Lesson missing lessonId`);
      assert.ok(lesson.name && typeof lesson.name === 'string',
        `Lesson ${lesson.lessonId} missing name`);
      assert.ok(lesson.description && typeof lesson.description === 'string',
        `Lesson ${lesson.lessonId} missing description`);
      assert.ok(lesson.exemplar && typeof lesson.exemplar === 'string',
        `Lesson ${lesson.lessonId} missing exemplar`);
      assert.ok(Array.isArray(lesson.learningObjectives) && lesson.learningObjectives.length > 0,
        `Lesson ${lesson.lessonId} must have at least one learning objective`);
    }
  });

  it('every learning objective is a non-empty string', () => {
    for (const lesson of lessons) {
      for (const obj of lesson.learningObjectives) {
        assert.ok(typeof obj === 'string' && obj.length > 0,
          `Lesson ${lesson.lessonId} has invalid learning objective`);
      }
    }
  });

  it('lessonIds are unique', () => {
    const ids = lessons.map(c => c.lessonId);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `Duplicate lessonIds: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  });
});

describe('parseLessonPrompt — Coach Directive', () => {
  const base = [
    '# Deploy a WordPress site',
    '',
    'Ship a live WordPress site for your portfolio project.',
    '',
    '## Exemplar',
    'A deployed WordPress site the learner can explain the hosting choice for.',
    '',
    '## Learning Objectives',
    '- Can compare managed, self-hosted, and WordPress.com hosting',
    '- Can register a domain that represents their project',
  ];

  it('omits coachDirective when the section is absent', () => {
    const parsed = parseLessonPrompt('custom-1', base.join('\n'));
    assert.equal('coachDirective' in parsed, false);
    assert.equal(parsed.exemplar, 'A deployed WordPress site the learner can explain the hosting choice for.');
    assert.equal(parsed.learningObjectives.length, 2);
  });

  it('captures a multi-line coach directive verbatim, codes and URLs intact', () => {
    const directive = [
      'Reference the learner\'s portfolio project throughout. Do not ask what it is.',
      '',
      'If they choose WordPress.com, share code "EduAIMicroCred26": https://wordpress.com/start/business-monthly/?coupon=EduAIMicroCred26',
    ];
    const md = [...base, '', '## Coach Directive', ...directive].join('\n');
    const parsed = parseLessonPrompt('custom-1', md);

    assert.equal(parsed.coachDirective, directive.join('\n'));
    assert.match(parsed.coachDirective, /EduAIMicroCred26/);
    assert.match(parsed.coachDirective, /coupon=EduAIMicroCred26/);
    // The directive must not bleed into the exemplar or objectives.
    assert.equal(parsed.learningObjectives.length, 2);
    assert.doesNotMatch(parsed.exemplar, /EduAIMicroCred26/);
  });
});
