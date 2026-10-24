/**
 * The learner shell's layout (DESIGN.md: Layout, Navigation): the lesson page
 * fills the space between the shell's bars instead of assuming their height,
 * its sticky header shares the conversation's column and stays compact, focus
 * scrolls clear of the sticky bars, and the classroom header leads with the
 * classroom while sharing the row fairly with the account menu.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');
// Normalize line endings: Windows checkouts use CRLF.
const read = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

describe('lesson page', () => {
  it('fills the space between the shell bars without assuming their height', () => {
    const chat = read('pages/LessonChat.jsx');
    assert.match(chat, /<div className="lesson-page flex flex-1 flex-col">/);
    assert.equal(/100dvh/.test(chat), false, 'no viewport height minus a guessed chrome height');
    assert.match(read('index.css'), /#main-content:has\(> \.lesson-page\)\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;\s*\}/);
    // The document stays the scroller, or the sticky lesson header stops sticking.
    const shell = read('components/AppShell.jsx');
    const main = shell.match(/<main id="main-content" className="([^"]*)"/)[1];
    assert.equal(/\boverflow-/.test(main), false);
  });

  it('keeps its sticky header in the conversation column, with the outline beside the title', () => {
    const chat = read('pages/LessonChat.jsx');
    const header = chat.slice(chat.indexOf('id="lesson-header"'), chat.indexOf('<ProgressBar'));
    assert.match(header, /<div className="mx-auto max-w-3xl flex items-center gap-2">/);
    assert.match(read('components/chat/ChatArea.jsx'), /mx-auto max-w-3xl/);
    assert.match(read('components/chat/ComposeBar.jsx'), /mx-auto max-w-3xl/);
    assert.match(header, /<h1 ref=\{headingRef\} tabIndex=\{-1\} className="text-base font-semibold/);
    // A 44px hit area from an overlay, so the text action doesn't grow its row.
    assert.match(header, /className="touch-target-inline [^"]*"[\s\S]*?View outline/);
    assert.match(read('index.css'), /button:not\(\.compose-chip-remove\):not\(\.touch-target-inline\), select, \[role="menuitem"\]/);
  });

  it('scrolls focus clear of the sticky header and composer, however tall they grow', () => {
    const chat = read('pages/LessonChat.jsx');
    assert.match(chat, /const \[stickyTopRef, stickyBottomRef\] = useStickyScrollPadding\(\);/);
    assert.match(chat, /id="lesson-header" ref=\{stickyTopRef\}/);
    assert.match(chat, /ref=\{stickyBottomRef\}\s*className="compose-sticky-bar/);
    const hook = read('hooks/useStickyScrollPadding.js');
    assert.match(hook, /'--sticky-top'/);
    assert.match(hook, /'--sticky-bottom'/);
    assert.match(hook, /new ResizeObserver\(measure\)/);
    assert.match(hook, /removeProperty\(name\)/);
    // Short viewports pin nothing, so the padding drops to a sliver there.
    const css = read('index.css');
    const short = css.slice(css.indexOf('@media (max-height: 34em)'));
    assert.match(short.slice(0, short.indexOf('\n}\n')), /html \{\s*scroll-padding-top: 0\.5rem;\s*scroll-padding-bottom: 0\.5rem;/);
  });
});

describe('classroom header', () => {
  it('leads with the classroom and shares the row fairly with the account menu', () => {
    const shell = read('components/AppShell.jsx');
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    // Each name takes what it needs; only when both run long do they split the row.
    assert.match(header, /grid grid-cols-\[minmax\(0,max-content\)_minmax\(0,max-content\)\] items-center justify-between/);
    assert.equal(/max-w-\[(60|45)%\]/.test(header), false, 'no fixed caps that cut a name short while the row has room');
    assert.match(header, /<span className="truncate text-base font-semibold">\{classroomName\}<\/span>/);
    // A wide wordmark keeps its proportions instead of shrinking into a square.
    assert.match(header, /className="h-8 w-auto max-w-full object-contain"/);
    // The account trigger reads as a menu.
    assert.match(header, /<ChevronDown aria-hidden="true" className="size-4 shrink-0" \/>/);
  });

  it('pads inside the shared column, so the classroom name lines up with the page', () => {
    const shell = read('components/AppShell.jsx');
    assert.match(shell, /<nav className="mx-auto max-w-5xl px-4 grid/);
    assert.match(shell, /<nav aria-label="Admin" className="mx-auto max-w-5xl [^"]*px-4">/);
    assert.match(read('pages/LessonsList.jsx'), /<div className="mx-auto max-w-5xl p-4">/);
    assert.equal(/pl-\[max\(1rem,env\(safe-area-inset-left\)\)\]/.test(shell), false);
  });
});
