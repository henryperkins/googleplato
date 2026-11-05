/**
 * Hardening of the learner's lesson list (/lessons): focus when paging, the
 * card's focus ring, right-to-left author text, forced colors, and unbroken
 * words. tests/browser/lessons-list.test.js checks the focus behavior in a
 * browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
// Normalize line endings: Windows checkouts use CRLF.
const read = (rel) => fs.readFileSync(path.join(dir, '../src', rel), 'utf8').replace(/\r\n/g, '\n');
const page = read('pages/LessonsList.jsx');
const css = read('index.css');

describe('lesson list paging', () => {
  it('moves focus to the page heading, stepping from the page shown', () => {
    assert.match(page, /const goToPage = \(next\) => \{[\s\S]*?if \(target === currentPage\) return;\s*setPage\(target\);\s*headingRef\.current\?\.focus\(\);/);
    assert.match(page, /onClick=\{\(\) => goToPage\(currentPage - 1\)\}/);
    assert.match(page, /onClick=\{\(\) => goToPage\(currentPage \+ 1\)\}/);
  });

  it('keeps Previous and Next focusable while disabled, so focus never falls to the document', () => {
    const nav = page.slice(page.indexOf('aria-label="Lessons pagination"'), page.indexOf('</nav>'));
    assert.equal(nav.match(/\bfocusableWhenDisabled\b/g)?.length, 2);
  });
});

describe('lesson card focus ring', () => {
  it('rings the whole card when its open action has focus, instead of a clipped line', () => {
    assert.match(page, /<Card className="lesson-card /);
    assert.match(page, /className="lesson-open /);
    assert.match(css, /@supports selector\(:has\(\*\)\) \{\s*\.lesson-open:focus-visible \{\s*outline: none;\s*\}\s*\.lesson-card:has\(\.lesson-open:focus-visible\) \{\s*outline: 3px solid var\(--ring\);\s*outline-offset: 2px;\s*\}\s*\}/);
  });
});

describe('author text direction', () => {
  it('lets lesson titles, descriptions and course names set their own direction', () => {
    for (const pattern of [
      /<span dir="auto" className="wrap-anywhere text-base font-semibold/,
      /<p dir="auto" className="wrap-anywhere text-sm text-muted-foreground line-clamp-2/,
      /<h2 dir="auto" className=\{GROUP_HEADING\}>/,
      /<h2 dir="auto" className=\{`mb-3 \$\{GROUP_HEADING\}`\}>/,
      /<bdi title=\{part\.title\}>\{part\.text\}<\/bdi>/,
      /<p dir="auto" className="text-xs font-semibold uppercase/,
      /<DialogTitle dir="auto" /,
      /<DialogDescription dir="auto" /,
      /<ul dir="auto" className="list-disc ps-5 /,
    ]) assert.match(page, pattern);
  });

  it('aligns and indents by the text direction, not left', () => {
    assert.match(page, /className="lesson-open [^"]*\btext-start\b/);
    assert.doesNotMatch(page, /\b(text-left|pl-5)\b/);
  });
});

describe('forced colors and unbroken words', () => {
  it('keeps the card and Start here outlines when forced colors drop fills and shadows', () => {
    assert.match(page, /<Card className="lesson-card [^"]*\bforced-colors:outline-1\b/);
    assert.match(page, /\bbg-primary [^"]*\bforced-colors:outline-1\b/);
  });

  it('keeps both progress bars when forced colors drop their fills: an outlined track, a fill in the text color', () => {
    const bars = [...page.matchAll(/className="([^"]*\bbg-track\b[^"]*)"\s*>\s*<div\s+className=\{`([^`]*)`\}/g)];
    assert.equal(bars.length, 2, 'the course summary and outline progress bars');
    for (const [, track, fill] of bars) {
      assert.match(track, /\bforced-colors:outline-1\b/);
      assert.match(fill, /\bforced-colors:bg-\[color:CanvasText\]/);
    }
  });

  it('wraps an unbroken word in the outline title, with leading for a long one', () => {
    assert.match(page, /<DialogTitle dir="auto" className="wrap-anywhere leading-snug">/);
  });
});
