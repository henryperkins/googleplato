/**
 * Contracts from the harden pass: controls that start async work keep focus
 * (nothing falls to <body>), learner text keeps its line breaks, page titles
 * are real headings, and field boundaries hold 3:1 contrast.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');
// Normalize line endings: Windows checkouts use CRLF, and `.` never matches \r.
const read = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

// The JSX element that owns each match of `propPattern`: props sit inside the
// opening tag, so the nearest `<` before a prop starts its element.
function owningTags(src, propPattern) {
  return [...src.matchAll(propPattern)].map((m) => {
    const open = src.lastIndexOf('<', m.index);
    return src.slice(open + 1).match(/^[\w.]+/)[0];
  });
}

// Relative luminance of an achromatic oklch() color: OKLab L is the cube root
// of luminance for neutrals, so Y = L³.
const luminance = (l) => l ** 3;
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

describe('Focus survives async work', () => {
  it('keeps the composer editable while a reply streams and refocuses it after sending', () => {
    const compose = read('components/chat/ComposeBar.jsx');
    assert.match(compose, /busy = false/);
    assert.match(compose, /<textarea[\s\S]*?disabled=\{disabled\}/);
    assert.match(compose, /disabled=\{disabled \|\| busy \|\| !hasContent \|\| attaching\}/);
    assert.match(compose, /onSend\(payload\);\s*\n(\s*\/\/.*\n)*\s*inputRef\.current\?\.focus\(\);/);

    const chat = read('pages/LessonChat.jsx');
    assert.match(chat, /disabled=\{impersonating\}\s*\n\s*busy=\{busy\}/);
    for (const rel of ['pages/admin/LessonEditor.jsx', 'pages/admin/KnowledgeBaseEditor.jsx']) {
      assert.match(read(rel), /<ComposeBar[\s\S]*?busy=\{/, `${rel} should hold sending, not disable the composer`);
    }
  });

  it('offers a retry when a lesson fails to start', () => {
    const chat = read('pages/LessonChat.jsx');
    assert.match(chat, /startFailed && \(\s*<Button[^>]*onClick=\{retryStart\}[^>]*>Try again<\/Button>/);
    assert.match(chat, /Lesson not found<\/h1>/);
  });

  it('makes fields read-only, not disabled, while forms save', () => {
    const forms = [
      'pages/Settings.jsx',
      'pages/ForgotPassword.jsx',
      'pages/ResetPassword.jsx',
      'components/ProfileCompletionGate.jsx',
    ];
    for (const rel of forms) {
      const src = read(rel);
      assert.match(src, /readOnly=\{/, `${rel} should hold field values with readOnly`);
      assert.match(src, /focusableWhenDisabled/, `${rel} should keep its submit button focusable`);
      const saving = /disabled=\{(submitting|saving|fieldsSaving|\w+Submitting)\b/g;
      for (const tag of owningTags(src, saving)) {
        assert.equal(tag, 'Button', `${rel} disables a <${tag}> while saving; fields should be readOnly`);
      }
    }
    for (const rel of ['pages/Login.jsx', 'pages/Signup.jsx', 'pages/Setup.jsx', 'pages/Waitlist.jsx']) {
      assert.match(read(rel), /focusableWhenDisabled/, `${rel} submit buttons should stay focusable`);
    }
  });

  it('moves focus to confirmations that replace a form', () => {
    const reset = read('pages/ResetPassword.jsx');
    assert.match(reset, /if \(done\) doneRef\.current\?\.focus\(\)/);
    assert.equal(/setTimeout\(\(\) => navigate/.test(reset), false, 'reset success should not redirect on a timer');
    const waitlist = read('pages/Waitlist.jsx');
    assert.match(waitlist, /if \(done\) doneRef\.current\?\.focus\(\)/);
  });

  it('styles focusable disabled buttons as disabled', () => {
    assert.match(read('components/ui/button.jsx'), /aria-disabled:pointer-events-none aria-disabled:opacity-50/);
  });
});

describe('Content fidelity and semantics', () => {
  it('keeps line breaks in learner messages', () => {
    assert.match(read('components/chat/UserMessage.jsx'), /className="whitespace-pre-wrap"/);
  });

  it('makes each auth page title its single h1', () => {
    const pages = ['Login', 'Signup', 'Setup', 'ForgotPassword', 'ResetPassword', 'Waitlist', 'Privacy'];
    for (const name of pages) {
      const src = read(`pages/${name}.jsx`);
      assert.match(src, /<CardTitle as="h1"/, `${name} title should be the page h1`);
      assert.equal(/<h1\b/.test(src), false, `${name} should not have a second h1`);
    }
  });
});

describe('Field boundaries', () => {
  it('hold 3:1 against white and the learner workspace (WCAG 1.4.11)', () => {
    const css = read('index.css');
    const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
    const l = Number(root.match(/--input:\s*oklch\(([\d.]+) 0 0\)/)[1]);
    const white = luminance(1);
    const workspace = luminance(0.97);
    assert.ok(contrast(luminance(l), white) >= 3, `--input is ${contrast(luminance(l), white).toFixed(2)}:1 on white`);
    assert.ok(contrast(luminance(l), workspace) >= 3, `--input is ${contrast(luminance(l), workspace).toFixed(2)}:1 on the workspace`);
  });
});
