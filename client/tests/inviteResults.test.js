/**
 * inviteResults — the pure result-to-message mapping for admin invites
 * (EML-1). When email delivery is off the UI must say so and hand the admin
 * copyable links instead of claiming an invite was sent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { describeBulkInvites, describeSingleInvite, describeAdminReset } = await import('../src/lib/inviteResults.js');

describe('describeBulkInvites', () => {
  it('reports sent invites', () => {
    const out = describeBulkInvites({ sent: 2, linkOnly: 0, skipped: 0, total: 2, results: [] });
    assert.match(out.text, /2 invites sent/);
    assert.deepEqual(out.links, []);
  });

  it('reports link-only results with copyable links', () => {
    const out = describeBulkInvites({
      sent: 0, linkOnly: 1, skipped: 1, total: 2,
      results: [
        { email: 'a@example.com', status: 'link_only', signupUrl: 'https://x/signup?token=t1' },
        { email: 'b@example.com', status: 'skipped' },
      ],
    });
    assert.match(out.text, /Email delivery is off/);
    assert.deepEqual(out.links, [{ email: 'a@example.com', signupUrl: 'https://x/signup?token=t1' }]);
  });

  it('reports mixed sent and link-only results', () => {
    const out = describeBulkInvites({
      sent: 1, linkOnly: 1, skipped: 0, total: 2,
      results: [{ email: 'a@example.com', status: 'link_only', signupUrl: 'https://x/signup?token=t1' }],
    });
    assert.match(out.text, /1 invite sent/);
    assert.match(out.text, /Email delivery is off/);
    assert.equal(out.links.length, 1);
  });
});

describe('describeSingleInvite', () => {
  it('sent copy names the recipient', () => {
    const out = describeSingleInvite('a@example.com', { emailDelivery: 'sent' });
    assert.equal(out.text, 'Invite sent to a@example.com.');
    assert.deepEqual(out.links, []);
  });

  it('off copy offers the copyable link', () => {
    const out = describeSingleInvite('a@example.com', { emailDelivery: 'off', signupUrl: 'https://x/signup?token=t1' });
    assert.match(out.text, /Email delivery is off/);
    assert.deepEqual(out.links, [{ email: 'a@example.com', signupUrl: 'https://x/signup?token=t1' }]);
  });
});

describe('describeAdminReset', () => {
  it('sent copy', () => {
    assert.equal(describeAdminReset('a@example.com', { emailDelivery: 'sent' }), 'Password reset email sent to a@example.com.');
  });

  it('off copy says no email was sent', () => {
    assert.equal(describeAdminReset('a@example.com', { emailDelivery: 'off' }), 'Email delivery is off, so no reset email was sent.');
  });
});
