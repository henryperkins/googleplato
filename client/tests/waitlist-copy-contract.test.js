/**
 * Existing-account wait-list entries now produce an invitation requiring the
 * account owner's acceptance. Preserve the row request guard, truthful pending
 * labels and route ownership from the former direct-copy flow. Rendered
 * double-submit and navigation regressions live in task2-integration.spec.js.
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
    assert.doesNotMatch(users, /applyFromWaitlist|Copy to account/);
    assert.match(users, /pendingRows\[item\._key\] === 'invite' \? 'Sending…' : 'Invite'/);
  });

  it('mobile rows name only the running action', () => {
    assert.match(mobile, /const primaryAction = item\._type === 'waitlist' \? 'invite' : 'resend';/);
    assert.match(mobile, /primaryRunning \? 'Sending…'/);
    assert.match(mobile, /pendingAction === 'remove' \? 'Removing…' : 'Remove'/);
    assert.match(mobile, /onInvite\(item\._key, item\.email\)/);
  });

  it('the edit screen hears which action is running and holds every control', () => {
    assert.match(users, /removing=\{pendingRows\[editEntry\.inviteToken\] === 'remove'\}/);
    assert.match(edit, /const busy = saving \|\| inviting \|\| removing;/);
    assert.match(edit, /onClick=\{invite\} disabled=\{busy \|\| dirty\}/);
    assert.match(edit, /readOnly=\{busy \|\| !canEdit\}/);
    assert.match(edit, /disabled=\{busy \|\| !canEdit\}/);
    assert.match(edit, /removing \? 'Removing…' : 'Remove from wait list'/);
    assert.match(edit, /inviting \? 'Sending invite…' : removing \? 'Removing entry…' : ''/);
  });
});

describe('Existing-account invitation', () => {
  it('uses an Invite name and suppresses duplicate pending invitations', () => {
    assert.match(users, /aria-label=\{`Invite \$\{item\.email\}`\}/);
    assert.match(users, /alreadyRegistered !== 'invite'/);
    assert.match(mobile, /alreadyRegistered !== 'invite'/);
    assert.doesNotMatch(mobile, /Copy to account|onApply/);
    assert.match(edit, /canInvite && entry\.alreadyRegistered !== 'invite'/);
  });
});

describe('Edit-screen completion navigation', () => {
  it('only returns to the list when the admin is still viewing that entry', () => {
    assert.match(users, /const editTokenRef = useRef\(waitlistToken\)/);
    for (const handler of ['onSaved', 'onInvite', 'onRemove']) {
      const line = users.split('\n').find(l => l.trim().startsWith(`${handler}=`));
      assert.ok(line, `the wait-list editor receives ${handler}`);
      assert.match(line, /editTokenRef\.current === (?:e|editEntry)\.inviteToken\) back\(\)/, `${handler} checks the open entry before going back`);
    }
  });
});
