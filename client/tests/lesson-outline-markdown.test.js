/**
 * Learners see author-written lesson markdown the way the editor preview
 * shows it: the line-clamped card shows plain text with the markers removed,
 * and the outline dialogs render inline formatting (the exemplar can hold
 * lists, so it gets the full renderer). Raw `**`, backticks, and [label](url)
 * syntax never reach a learner, and every description paragraph survives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLessonPrompt } from '../../server/src/shared/lessonMarkdown.js';

// esc() relies on the DOM's textContent→innerHTML escaping.
globalThis.document = {
  createElement: () => ({
    set textContent(v) { this._t = v; },
    get innerHTML() {
      return String(this._t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  }),
};
const { renderMd, renderInlineMd, stripInlineMd } = await import('../src/lib/helpers.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');
// Normalize line endings: Windows checkouts use CRLF.
const read = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

describe('lesson markdown on learner surfaces', () => {
  it('strips inline markdown from the clamped card description', () => {
    assert.match(read('pages/LessonsList.jsx'), /line-clamp-2[^>]*>\s*\{stripInlineMd\(lesson\.description\)\}/);
  });

  for (const rel of ['pages/LessonsList.jsx', 'pages/LessonChat.jsx']) {
    it(`renders lesson markdown in the ${rel} outline dialog`, () => {
      const src = read(rel);
      // DialogDescription is a <p>, so it only ever gets inline HTML.
      assert.match(src, /<DialogDescription className="coach-copy" dangerouslySetInnerHTML=\{\{ __html: renderInlineMd\(lesson\.description\) \}\} \/>/);
      assert.match(src, /<div className="coach-copy [^"]*" dangerouslySetInnerHTML=\{\{ __html: renderMd\(lesson\.exemplar\) \}\} \/>/);
      assert.match(src, /<li key=\{i\} className="coach-copy" dangerouslySetInnerHTML=\{\{ __html: renderInlineMd\(obj\) \}\} \/>/);
      assert.doesNotMatch(src, /\{lesson\.(description|exemplar)\}|<li key=\{i\}>\{obj\}<\/li>/, 'no raw author markdown as a text child');
    });
  }

  it('shows every description paragraph, formatted, from parsed lesson markdown', () => {
    const lesson = parseLessonPrompt('color', [
      '# Accessible color',
      '',
      'Learn **perceptual lightness** with `OKLCH`.',
      '',
      'Then check [WCAG 2.2 contrast](https://www.w3.org/TR/WCAG22/).',
      '',
      '## Exemplar',
      'A palette whose swatches:',
      '- name their **use**',
      '- meet `4.5:1`',
      '',
      '## Learning Objectives',
      '- Can explain *perceptual* lightness',
    ].join('\n'));

    assert.equal(stripInlineMd(lesson.description), 'Learn perceptual lightness with OKLCH. Then check WCAG 2.2 contrast.');
    assert.equal(
      renderInlineMd(lesson.description),
      'Learn <strong>perceptual lightness</strong> with <code>OKLCH</code>.<br><br>Then check <a href="https://www.w3.org/TR/WCAG22/" target="_blank" rel="noopener">WCAG 2.2 contrast</a>.',
    );
    assert.equal(renderMd(lesson.exemplar), 'A palette whose swatches:<ul><li>name their <strong>use</strong></li><li>meet <code>4.5:1</code></li></ul>');
    assert.equal(renderInlineMd(lesson.learningObjectives[0]), 'Can explain <em>perceptual</em> lightness');
  });
});
