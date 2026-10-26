/**
 * The lesson markdown parser shared by the client (lesson list, outline, and
 * editor) and the server (coach). Authors see the whole document in the
 * editor preview, so the description must keep every paragraph they wrote.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLessonPrompt } from '../../src/shared/lessonMarkdown.js';

const criteria = [
  '## Exemplar',
  'A palette with **documented** contrast ratios.',
  '',
  'Each swatch names its use.',
  '',
  '## Learning Objectives',
  '- Can explain perceptual lightness',
  '- Can check `OKLCH` contrast',
];
const lesson = (...intro) => ['# Accessible color', ...intro, ...criteria].join('\n');

describe('parseLessonPrompt description', () => {
  it('keeps a one-line description', () => {
    assert.equal(parseLessonPrompt('l', lesson('', 'Build a palette.', '')).description, 'Build a palette.');
  });

  it('keeps every intro paragraph, separated by one blank line', () => {
    const parsed = parseLessonPrompt('l', lesson(
      '',
      'Learn **perceptual lightness** with `OKLCH`.',
      '  Lines in a paragraph stay together.  ',
      '',
      '',
      '',
      'Then check [WCAG 2.2 contrast](https://www.w3.org/TR/WCAG22/).',
      '',
    ));
    assert.equal(parsed.description, 'Learn **perceptual lightness** with `OKLCH`.\nLines in a paragraph stay together.\n\nThen check [WCAG 2.2 contrast](https://www.w3.org/TR/WCAG22/).');
  });

  it('reads a ## Description section', () => {
    const parsed = parseLessonPrompt('l', lesson('', '## Description', '', 'Build a palette.', '', 'Then test it.', ''));
    assert.equal(parsed.description, 'Build a palette.\n\nThen test it.');
  });

  it('matches the Description heading regardless of case and spacing', () => {
    assert.equal(parseLessonPrompt('l', lesson('##  description  ', 'Build a palette.')).description, 'Build a palette.');
  });

  it('keeps intro prose and a ## Description section together, in document order', () => {
    const parsed = parseLessonPrompt('l', lesson('', 'A short tagline.', '', '## Description', 'The full description.', ''));
    assert.equal(parsed.description, 'A short tagline.\n\nThe full description.');
    // A Description section after the criteria still counts.
    const late = parseLessonPrompt('l', [...lesson('', 'Intro.').split('\n'), '', '## Description', 'Later detail.'].join('\n'));
    assert.equal(late.description, 'Intro.\n\nLater detail.');
  });

  it('ignores text before the title', () => {
    assert.equal(parseLessonPrompt('l', ['Draft notes', '', ...lesson('Build a palette.').split('\n')].join('\n')).description, 'Build a palette.');
  });

  it('is empty when the lesson has no description prose', () => {
    assert.equal(parseLessonPrompt('l', lesson('', '')).description, '');
    assert.equal(parseLessonPrompt('l', lesson('## Description', '')).description, '');
  });

  it('parses CRLF markdown exactly like LF', () => {
    const lf = lesson('', 'First paragraph.', '', 'Second paragraph.', '', '## Description', 'More.');
    const crlf = parseLessonPrompt('l', lf.replace(/\n/g, '\r\n')).description;
    assert.equal(crlf, parseLessonPrompt('l', lf).description);
    assert.equal(crlf, 'First paragraph.\n\nSecond paragraph.\n\nMore.');
  });
});

describe('parseLessonPrompt fenced sections', () => {
  for (const marker of ['```', '~~~', '````']) {
    it(`keeps Description headings inside ${marker} examples out of lesson metadata`, () => {
      const exemplar = ['A README containing this example:', `${marker}md`, '## Description', 'This text belongs to the example.', marker].join('\n');
      const parsed = parseLessonPrompt('headings', [
        '# Markdown headings', 'Learn to document a project.', '## Exemplar', exemplar,
        '## Learning Objectives', '- Can explain headings',
      ].join('\n'));
      assert.equal(parsed.description, 'Learn to document a project.');
      assert.equal(parsed.exemplar, exemplar);
      assert.deepEqual(parsed.learningObjectives, ['Can explain headings']);
    });
  }

  it('only closes with the same marker, at least the opening length, and no trailing content', () => {
    const directive = ['````md', '```', '~~~~', '```` still code', '## Description', 'Keep this directive.', '`````'].join('\n');
    const parsed = parseLessonPrompt('fences', [
      '# Fences', 'Intro.', '## Coach Directive', directive, '## Description', 'Actual description.',
    ].join('\n'));
    assert.equal(parsed.coachDirective, directive);
    assert.equal(parsed.description, 'Intro.\n\nActual description.');
  });

  it('keeps section headings and list items in an unclosed fence as content through EOF', () => {
    const exemplar = ['```md', '## Description', 'Still an example.', '## Learning Objectives', '- Can stay in the code'].join('\n');
    const parsed = parseLessonPrompt('stream', ['# Fences', 'Intro.', '## Exemplar', exemplar].join('\n'));
    assert.equal(parsed.description, 'Intro.');
    assert.equal(parsed.exemplar, exemplar);
    assert.deepEqual(parsed.learningObjectives, []);
  });

  it('closes container-indented examples without swallowing following sections', () => {
    const exemplar = ['- Example:', '  ```md', '  ## Description', '  Literal code.', '    ```'].join('\n');
    const parsed = parseLessonPrompt('nested', [
      '# Markdown exercise', 'Intro.', '## Exemplar', exemplar,
      '## Learning Objectives', '- Can describe fences', '## Description', 'Real description.',
    ].join('\n'));
    assert.equal(parsed.exemplar, exemplar);
    assert.deepEqual(parsed.learningObjectives, ['Can describe fences']);
    assert.equal(parsed.description, 'Intro.\n\nReal description.');
  });

  it('recognizes CRLF fences while preserving the exemplar line endings', () => {
    const exemplar = ['```md', '## Description', 'Literal example.', '```'].join('\r\n');
    const parsed = parseLessonPrompt('windows', [
      '# Markdown exercise', 'Intro.', '## Exemplar', exemplar,
      '## Learning Objectives', '- Can describe fences', '## Description', 'Real description.',
    ].join('\r\n'));
    assert.equal(parsed.exemplar, exemplar);
    assert.deepEqual(parsed.learningObjectives, ['Can describe fences']);
    assert.equal(parsed.description, 'Intro.\n\nReal description.');
  });
});

describe('parseLessonPrompt other fields', () => {
  it('returns the same shape, with the exemplar and objectives intact', () => {
    assert.deepEqual(parseLessonPrompt('l', lesson('', 'One.', '', 'Two.', '', '## Description', 'Three.', '')), {
      lessonId: 'l',
      name: 'Accessible color',
      description: 'One.\n\nTwo.\n\nThree.',
      exemplar: 'A palette with **documented** contrast ratios.\n\nEach swatch names its use.',
      learningObjectives: ['Can explain perceptual lightness', 'Can check `OKLCH` contrast'],
    });
  });

  it('keeps description prose out of the exemplar, objectives, and coach directive', () => {
    const md = [lesson('', 'Intro.'), '', '## Coach Directive', 'Reference the learner\'s project.', '', '## Description', 'Late description.'].join('\n');
    const parsed = parseLessonPrompt('l', md);
    assert.equal(parsed.coachDirective, 'Reference the learner\'s project.');
    assert.equal(parsed.exemplar, 'A palette with **documented** contrast ratios.\n\nEach swatch names its use.');
    assert.deepEqual(parsed.learningObjectives, ['Can explain perceptual lightness', 'Can check `OKLCH` contrast']);
    assert.equal(parsed.description, 'Intro.\n\nLate description.');
  });

  it('omits coachDirective when the section is absent', () => {
    assert.equal('coachDirective' in parseLessonPrompt('l', lesson('Intro.')), false);
  });
});
