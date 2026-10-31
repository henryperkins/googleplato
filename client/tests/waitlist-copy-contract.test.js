/**
 * Copy to account (upstream #482, merged in 9f3928f) must behave like Invite:
 * one request at a time per entry, a visible busy state while it runs, an
 * accessible name that starts with the visible label (WCAG 2.5.3), and no
 * navigation away from a different editor when a slow success lands.
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

const users = read('pages/admin/AdminUsers.jsx');
const edit = read('pages/admin/WaitlistEntryEdit.jsx');
const mobile = read('pages/admin/UserMobileList.jsx');

const applyFn = users.slice(
  users.indexOf('function applyFromWaitlist'),
  users.indexOf('function removeFromWaitlist'),
);

describe('Copy to account request guard', () => {
  it('refuses to start while an apply for the same entry is in flight', () => {
    assert.match(applyFn, /if \(pendingRowsRef\.current\.has\(token\)\) return;/);
    assert.match(applyFn, /pendingRowsRef\.current\.add\(token\)/);
    assert.match(applyFn, /finally \{[\s\S]*?pendingRowsRef\.current\.delete\(token\)/);
  });

  it('tracks the in-flight copy in pendingRows so every surface disables', () => {
    assert.match(applyFn, /setPendingRows\(prev => \(\{ \.\.\.prev, \[token\]: true \}\)\)/);
    assert.match(users, /applying=\{!!pendingRows\[editEntry\.inviteToken\]\}/);
  });
});

describe('Copy to account busy state', () => {
  it('desktop row shows Copying… while the request runs', () => {
    assert.match(users, /pendingRows\[item\._key\] \? 'Copying…' : 'Copy to account'/);
  });

  it('mobile row shows Copying… while the request runs', () => {
    assert.match(mobile, /hasAccount \? 'Copying…' : 'Sending…'/);
    assert.match(mobile, /onApply\(item\._key, item\.email\)/);
  });

  it('edit screen disables Copy and reports Copying… while applying', () => {
    assert.match(edit, /disabled=\{saving \|\| dirty \|\| inviting \|\| applying\}/);
    assert.match(edit, /applying \? 'Copying…' : 'Copy to account'/);
    assert.match(edit, /applying \? 'Copying answers to account…' : ''/);
  });
});

describe('Copy to account accessible name', () => {
  it('starts with the visible "Copy to account" label on desktop and mobile', () => {
    assert.match(users, /aria-label=\{`Copy to account for \$\{item\.email\}`\}/);
    assert.match(mobile, /aria-label=\{hasAccount \? `Copy to account for \$\{item\.email\}`/);
    assert.doesNotMatch(users, /aria-label=\{`Copy \$\{item\.email\}'s wait-list/);
    assert.doesNotMatch(mobile, /aria-label=\{hasAccount \? `Copy \$\{item\.email\}'s wait-list/);
  });
});

describe('Edit-screen completion navigation', () => {
  it('only returns to the list when the admin is still viewing that entry', () => {
    assert.match(users, /const editTokenRef = useRef\(waitlistToken\)/);
    assert.match(users, /editTokenRef\.current === e\.inviteToken/);
  });
});
