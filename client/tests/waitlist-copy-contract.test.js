/**
 * Copy to account (upstream #482, merged in 9f3928f) must behave like Invite:
 * one request at a time per entry, a visible busy state while it runs, an
 * accessible name that starts with the visible label (WCAG 2.5.3), and no
 * navigation away from a different editor when a slow success lands. A row
 * records which action is running, so a removal never reads as a copy or an
 * invite. client/tests/browser/admin-responsive.test.js covers the same
 * behavior in a browser.
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

// The source of a function declared in the AdminUsers component body, up to
// the next declaration or comment at the same indentation. It fails when the
// function is missing, so no assertion can pass against the wrong code or none.
function componentFunction(name) {
  const start = users.search(new RegExp(`\\n {2}(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `AdminUsers.jsx declares ${name}`);
  const body = users.slice(start + 1);
  const end = body.search(/\n {2}(?:(?:async )?function |const |\/\/ )/);
  assert.notEqual(end, -1, `${name} is followed by another declaration`);
  return body.slice(0, end);
}

describe('Wait-list row request guard', () => {
  for (const [name, action, request] of [
    ['applyFromWaitlist', 'copy', /adminApi\('POST', `\/v1\/admin\/waitlist\/\$\{token\}\/apply`\)/],
    ['removeFromWaitlist', 'remove', /adminApi\('DELETE', `\/v1\/admin\/waitlist\/\$\{token\}`\)/],
  ]) {
    it(`${name} sends one request per entry and records it as "${action}"`, () => {
      const source = componentFunction(name);
      assert.match(source, request);
      // Once before the confirmation opens, and again when it is confirmed.
      assert.equal(source.match(/if \(pendingRowsRef\.current\.has\(token\)\) return;/g)?.length, 2);
      assert.match(source, /pendingRowsRef\.current\.add\(token\)/);
      assert.match(source, new RegExp(`setPendingRows\\(prev => \\(\\{ \\.\\.\\.prev, \\[token\\]: '${action}' \\}\\)\\)`));
      assert.match(source, /finally \{[\s\S]*?pendingRowsRef\.current\.delete\(token\)/);
    });
  }

  it('Invite and Resend record their own actions', () => {
    assert.match(componentFunction('inviteFromWaitlist'), /setPendingRows\(prev => \(\{ \.\.\.prev, \[token\]: 'invite' \}\)\)/);
    assert.match(componentFunction('resendInvite'), /setPendingRows\(prev => \(\{ \.\.\.prev, \[key\]: 'resend' \}\)\)/);
  });
});

describe('Wait-list busy state', () => {
  it('desktop rows name only the running action', () => {
    assert.match(users, /pendingRows\[item\._key\] === 'copy' \? 'Copying…' : 'Copy to account'/);
    assert.match(users, /pendingRows\[item\._key\] === 'invite' \? 'Sending…' : 'Invite'/);
  });

  it('mobile rows name only the running action', () => {
    assert.match(mobile, /const primaryAction = hasAccount \? 'copy' : item\._type === 'waitlist' \? 'invite' : 'resend';/);
    assert.match(mobile, /primaryRunning \? \(hasAccount \? 'Copying…' : 'Sending…'\)/);
    assert.match(mobile, /pendingAction === 'remove' \? 'Removing…' : 'Remove'/);
    assert.match(mobile, /onApply\(item\._key, item\.email\)/);
  });

  it('the edit screen hears which action is running and holds every control', () => {
    assert.match(users, /applying=\{pendingRows\[editEntry\.inviteToken\] === 'copy'\}/);
    assert.match(users, /removing=\{pendingRows\[editEntry\.inviteToken\] === 'remove'\}/);
    assert.match(edit, /const busy = saving \|\| inviting \|\| applying \|\| removing;/);
    assert.equal(edit.match(/disabled=\{busy \|\| dirty\}/g)?.length, 2, 'Copy and Invite wait for any action');
    assert.equal(edit.match(/disabled=\{busy\}/g)?.length, 4, 'Save, Cancel, Back and Remove wait for any action');
    assert.equal(edit.match(/readOnly=\{busy\}/g)?.length, 3, 'Name, email and custom fields are read-only');
    assert.match(edit, /aria-readonly=\{busy \|\| undefined\}/);
    assert.match(edit, /applying \? 'Copying…' : 'Copy to account'/);
    assert.match(edit, /removing \? 'Removing…' : 'Remove from wait list'/);
    assert.match(edit, /applying \? 'Copying answers to account…' : removing \? 'Removing entry…' : ''/);
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
    for (const handler of ['onSaved', 'onInvite', 'onApply', 'onRemove']) {
      const line = users.split('\n').find(l => l.trim().startsWith(`${handler}=`));
      assert.ok(line, `the wait-list editor receives ${handler}`);
      assert.match(line, /editTokenRef\.current === (?:e|editEntry)\.inviteToken\) back\(\)/, `${handler} checks the open entry before going back`);
    }
  });
});
