/**
 * Contracts from the harden pass for failure states and admin guards: one
 * failure never blanks the app, refreshes don't unmount admin pages, unknown
 * credential state never skips a replacement confirmation, and admin state is
 * exposed as text and semantics, not color or flipping labels.
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

describe('Error boundaries', () => {
  it('wraps every route tree in a boundary that resets on navigation', () => {
    const app = read('App.jsx');
    const boundaries = app.match(/<ErrorBoundary resetKey=\{location\.pathname\}>/g) || [];
    assert.equal(boundaries.length, 2, 'both the setup and the main route trees need a boundary');
    const boundary = read('components/ErrorBoundary.jsx');
    assert.match(boundary, /getDerivedStateFromError/);
    assert.match(boundary, /prevProps\.resetKey !== this\.props\.resetKey/);
    assert.match(boundary, /<h1 ref=\{this\.headingRef\} tabIndex=\{-1\}/);
  });

  it('isolates each plugin slot component and survives a failed registry', () => {
    const slot = read('lib/plugins/Slot.jsx');
    assert.match(slot, /<PluginBoundary key=\{pluginId\} pluginId=\{pluginId\}>/);
    assert.match(slot, /initPluginRegistry\(\)\s*\n\s*\.catch\(/);
  });
});

describe('Admin pages stay mounted through refreshes', () => {
  it('shows the full-page spinner only on the first load', () => {
    assert.match(read('pages/admin/AdminUsers.jsx'), /if \(loading && !loaded\) return/);
    assert.match(read('pages/admin/AdminLessons.jsx'), /if \(loading && !lessonsLoaded\) return spinner/);
    const plugins = read('pages/admin/AdminPlugins.jsx');
    assert.match(plugins, /if \(loading && !loaded\)/);
    assert.equal(/if \(error\) \{\s*return/.test(plugins), false, 'a plugin error should not replace the page');
  });

  it('sets admin titles per view, not once on mount', () => {
    assert.match(read('pages/admin/AdminLessons.jsx'), /if \(onList\) document\.title = 'Lessons — plato'/);
    assert.match(read('pages/admin/AdminUsers.jsx'), /document\.title = `Edit \$\{editUserName\} — plato`/);
  });
});

describe('Destructive and credential actions', () => {
  it('confirms group deletion and says how many users it touches', () => {
    const users = read('pages/admin/AdminUsers.jsx');
    assert.match(users, /function deleteGroup\(name\) \{[\s\S]*?setConfirmModal\(\{[\s\S]*?title: 'Delete group\?'/);
    assert.match(users, /cleared from \$\{members\}/);
  });

  it('treats a failed credential status load as unknown, not none', () => {
    const users = read('pages/admin/AdminUsers.jsx');
    assert.equal(/invites\/link'\)\.catch\(\(\) => null\)/.test(users), false);
    assert.match(users, /\{linkLoadFailed \? \(/);
    assert.match(users, /loadFailed=\{waitlistLoadFailed\}/);
    assert.match(read('pages/admin/WaitlistDialog.jsx'), /\{loadFailed \? \(/);
  });

  it('holds Invite until wait-list edits are saved', () => {
    const edit = read('pages/admin/WaitlistEntryEdit.jsx');
    assert.match(edit, /disabled=\{saving \|\| dirty\}/);
    assert.match(edit, /aria-describedby=\{dirty \? 'wl-edit-invite-hint' : undefined\}/);
  });
});

describe('Admin state as text and semantics', () => {
  it('names the duration warning in text, not only color', () => {
    const home = read('pages/admin/AdminHome.jsx');
    assert.match(home, /\{durationWarning && \(\s*<div[^>]*text-warning-foreground/);
    assert.equal(/hover:underline" role="alert"/.test(home), false, 'the knowledge base nudge is a link, not an alert');
  });

  it('announces logo errors and validates hex colors', () => {
    const customizer = read('pages/admin/AdminCustomizer.jsx');
    assert.match(customizer, /<p id="logo-file-error" className="text-sm text-destructive" role="alert">/);
    assert.match(customizer, /aria-describedby=\{logoError \? 'logo-file-error logo-file-hint' : 'logo-file-hint'\}/);
    assert.match(customizer, /aria-invalid=\{colorErrors\.primary \? true : undefined\}/);
    assert.match(customizer, /<CardTitle as="h2">Colors<\/CardTitle>/);
  });

  it('keeps the plugin switch label fixed so state comes from aria-checked', () => {
    assert.match(read('pages/admin/AdminPlugins.jsx'), /label=\{`Enable \$\{plugin\.name\}`\}/);
  });

  it('uses native radios for lesson visibility', () => {
    const share = read('components/modals/ShareLessonModal.jsx');
    assert.match(share, /type="radio"/);
    assert.equal(/role="radio"/.test(share), false);
    assert.match(share, /<legend className="sr-only">Lesson visibility<\/legend>/);
  });

  it('standardizes admin tables with card containers, accessible row headers, and modal states', () => {
    const lessons = read('pages/admin/AdminLessons.jsx');
    const users = read('pages/admin/AdminUsers.jsx');
    const courses = read('pages/admin/CoursesModal.jsx');
    const ring = read('pages/admin/CompletionRing.jsx');

    assert.match(lessons, /<Card className="p-0 overflow-hidden">/);
    assert.match(users, /<Card className="p-0 overflow-hidden">/);
    assert.match(lessons, /<TableCell as="th" scope="row"/);
    assert.match(users, /<TableCell as="th" scope="row"/);
    assert.match(courses, /aria-pressed=\{editingId === c\.courseId\}/);
    assert.match(ring, /className="text-input" stroke="currentColor"/);
  });

  it('keeps admin empty states full-width and pagination in sync at the edges', () => {
    const lessons = read('pages/admin/AdminLessons.jsx');
    const users = read('pages/admin/AdminUsers.jsx');

    assert.match(lessons, /setPage\(\(previous\) => Math\.min\(previous, totalPages\)\)/);
    for (const src of [lessons, users]) {
      assert.match(src, /static! max-w-none! border-r-0! bg-transparent! whitespace-normal/);
    }
  });

  it('announces a field move only after the reorder request succeeds', () => {
    const fields = read('pages/admin/UserFieldsDialog.jsx');
    assert.match(fields, /const ok = await run\(\(\) => adminApi\('PUT', '\/v1\/admin\/user-fields\/order'/);
    assert.match(fields, /Failed to reorder/);
  });
});
