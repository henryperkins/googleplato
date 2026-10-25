import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lockBackgroundScroll,
  unlockBackgroundScroll,
  resetScrollLockForTests,
} from '../src/lib/scrollLock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');

describe('scrollLock utility', () => {
  beforeEach(() => {
    resetScrollLockForTests();
  });

  it('locks and unlocks documentElement overflow and overscrollBehavior with reference counting', () => {
    const docEl = { style: { overflow: '', overscrollBehavior: '' } };
    const body = { style: { position: '', top: '', left: '', right: '', width: '' } };
    let scrolledTo = null;

    globalThis.document = {
      documentElement: docEl,
      body,
    };
    globalThis.window = {
      scrollY: 120,
      pageYOffset: 120,
      scrollTo: (x, y) => {
        scrolledTo = { x, y };
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      },
      configurable: true,
    });

    lockBackgroundScroll();
    assert.equal(docEl.style.overflow, 'hidden');
    assert.equal(docEl.style.overscrollBehavior, 'contain');

    // Nested overlay lock increments reference count
    lockBackgroundScroll();
    assert.equal(docEl.style.overflow, 'hidden');

    // First unlock leaves scroll locked while parent overlay remains open
    unlockBackgroundScroll();
    assert.equal(docEl.style.overflow, 'hidden');

    // Final unlock restores original styles
    unlockBackgroundScroll();
    assert.equal(docEl.style.overflow, '');
    assert.equal(docEl.style.overscrollBehavior, '');
    assert.equal(scrolledTo, null);
  });

  it('fixes body position on iOS Safari and restores scrollY on unlock', () => {
    const docEl = { style: { overflow: '', overscrollBehavior: '' } };
    const body = { style: { position: '', top: '', left: '', right: '', width: '' } };
    let scrolledTo = null;

    globalThis.document = {
      documentElement: docEl,
      body,
    };
    globalThis.window = {
      scrollY: 280,
      pageYOffset: 280,
      scrollTo: (x, y) => {
        scrolledTo = { x, y };
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        platform: 'iPhone',
        maxTouchPoints: 5,
      },
      configurable: true,
    });

    lockBackgroundScroll();
    assert.equal(docEl.style.overflow, 'hidden');
    assert.equal(body.style.position, 'fixed');
    assert.equal(body.style.top, '-280px');
    assert.equal(body.style.width, '100%');

    unlockBackgroundScroll();
    assert.equal(body.style.position, '');
    assert.equal(body.style.top, '');
    assert.deepEqual(scrolledTo, { x: 0, y: 280 });
  });
});

describe('Overlay, Popover, and Dense Table contracts', () => {
  it('uses native <dialog> with showModal() in dialog.jsx and alert-dialog.jsx', () => {
    const dialogSrc = fs.readFileSync(path.join(SRC_DIR, 'components/ui/dialog.jsx'), 'utf8');
    const alertDialogSrc = fs.readFileSync(path.join(SRC_DIR, 'components/ui/alert-dialog.jsx'), 'utf8');

    assert.match(dialogSrc, /<dialog\b/);
    assert.match(dialogSrc, /\.showModal\(\)/);
    assert.match(dialogSrc, /overscroll-contain/);
    assert.match(dialogSrc, /safe-area-inset-bottom/);

    assert.match(alertDialogSrc, /<dialog\b/);
    assert.match(alertDialogSrc, /role="alertdialog"/);
    assert.match(alertDialogSrc, /\.showModal\(\)/);
  });

  it('uses native popover="auto" in dropdown-menu.jsx with conditional focus return', () => {
    const menuSrc = fs.readFileSync(path.join(SRC_DIR, 'components/ui/dropdown-menu.jsx'), 'utf8');
    assert.match(menuSrc, /popover="auto"/);
    assert.match(menuSrc, /showPopover\(/);
    assert.match(menuSrc, /overscroll-contain/);
  });

  it('preserves native <table> semantics with sticky first column and overscroll-x-contain', () => {
    const tableSrc = fs.readFileSync(path.join(SRC_DIR, 'components/ui/table.jsx'), 'utf8');
    assert.match(tableSrc, /<table\b/);
    assert.match(tableSrc, /stickyFirstColumn/);
    assert.match(tableSrc, /overscroll-x-contain/);
    assert.match(tableSrc, /tabular-nums/);
    assert.match(tableSrc, /role="region"/);
    assert.match(tableSrc, /tabIndex=\{0\}/);
    assert.match(tableSrc, /scope = "col"/);
    assert.match(tableSrc, /as: Component = "td"/);
  });

  it('eliminates blocking window.alert() and window.confirm() across client/src', () => {
    function walkFiles(dir) {
      const results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walkFiles(full));
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
          results.push(full);
        }
      }
      return results;
    }

    const files = walkFiles(SRC_DIR);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(
        /\b(?:window\.)?alert\s*\(/.test(content),
        false,
        `Unexpected alert() in ${path.relative(SRC_DIR, file)}`
      );
      assert.equal(
        /\b(?:window\.)?confirm\s*\(/.test(content),
        false,
        `Unexpected confirm() in ${path.relative(SRC_DIR, file)}`
      );
      assert.equal(
        /-webkit-overflow-scrolling\s*:\s*touch/.test(content),
        false,
        `Unexpected legacy -webkit-overflow-scrolling: touch in ${path.relative(SRC_DIR, file)}`
      );
    }
  });

  it('enforces pointer-events drag with pinch-zoom preservation, passive scroll listeners, and overscroll containment', () => {
    const dialogSrc = fs.readFileSync(path.join(SRC_DIR, 'components/ui/dialog.jsx'), 'utf8');
    assert.match(dialogSrc, /\[touch-action:pan-x_pinch-zoom\]/);
    assert.equal(/\btouch-none\b/.test(dialogSrc), false);
    assert.match(dialogSrc, /setPointerCapture/);

    const stickSrc = fs.readFileSync(path.join(SRC_DIR, 'hooks/useStickToBottom.js'), 'utf8');
    assert.match(stickSrc, /capture:\s*true,\s*passive:\s*true/);

    const vvSrc = fs.readFileSync(path.join(SRC_DIR, 'hooks/useVisualViewportKeyboardOffset.js'), 'utf8');
    assert.match(vvSrc, /passive:\s*true/);

    const mdPaneSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/MarkdownPreviewPane.jsx'), 'utf8');
    assert.match(mdPaneSrc, /overscroll-contain/);

    const composeSrc = fs.readFileSync(path.join(SRC_DIR, 'components/chat/ComposeBar.jsx'), 'utf8');
    assert.match(composeSrc, /overscroll-contain/);

    const tabsSrc = fs.readFileSync(path.join(SRC_DIR, 'components/ui/tabs.jsx'), 'utf8');
    assert.match(tabsSrc, /overflow-x-auto/);
    assert.match(tabsSrc, /overscroll-x-contain/);

    const cssSrc = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
    assert.match(cssSrc, /\.coach-copy pre\s*\{[\s\S]*?overscroll-behavior-x:\s*contain/);
    assert.equal(/-webkit-overflow-scrolling\s*:\s*touch/.test(cssSrc), false);
  });
});

