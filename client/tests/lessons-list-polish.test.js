/**
 * Polish of the learner's lesson list (/lessons): card titles share a row's
 * top line, status marks align with their title, the outline opens on its
 * title, and paging uses the product's icons. tests/browser/lessons-list.test.js
 * measures the alignment in a browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
// Normalize line endings: Windows checkouts use CRLF.
const page = fs.readFileSync(path.join(dir, '../src/pages/LessonsList.jsx'), 'utf8').replace(/\r\n/g, '\n');

describe('lesson card alignment', () => {
  it('starts every title at the top of its card, so a row shares one top line', () => {
    // A button centers its content: a short title sat lower than a long one beside it.
    assert.match(page, /className="lesson-open [^"]*\bflex\b[^"]*\bflex-col\b[^"]*\bjustify-start\b/);
  });

  it("top-aligns each status mark with its title's first line, with no offset", () => {
    assert.match(page, /const sharedClass = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full';/);
    assert.match(page, /className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-in-progress-background /);
    assert.match(page, /className="flex h-6 shrink-0 items-center whitespace-nowrap rounded-full bg-primary /);
  });
});

describe('lesson outline header', () => {
  const dialog = page.slice(page.indexOf('function LessonDetailDialog'));
  const header = dialog.slice(dialog.indexOf('<DialogHeader>'), dialog.indexOf('</DialogHeader>'));

  it('opens on the title, with no label above it', () => {
    assert.match(header, /^<DialogHeader>\s*<DialogTitle /);
    assert.doesNotMatch(header, /\buppercase\b/);
  });

  it("names the course after the description, in the card's metadata style", () => {
    const course = header.indexOf('{lesson.course.name}');
    assert.ok(course > header.indexOf('<DialogDescription'), 'the course follows the description');
    assert.match(header, /<p dir="auto" className="wrap-anywhere text-xs leading-relaxed text-muted-foreground">\s*\{lesson\.course\.name\}/);
  });
});

describe('pagination icons', () => {
  it("draws Previous and Next arrows from the product's icon set, not text glyphs", () => {
    const nav = page.slice(page.indexOf('aria-label="Lessons pagination"'), page.indexOf('</nav>'));
    assert.match(nav, /<ArrowLeft aria-hidden="true" data-icon="inline-start" \/>\s*Previous/);
    assert.match(nav, /Next\s*<ArrowRight aria-hidden="true" data-icon="inline-end" \/>/);
    assert.doesNotMatch(nav, /&larr;|&rarr;|←|→/);
  });
});
