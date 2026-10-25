/**
 * Result-to-message mapping for admin invites and resets (EML-1).
 *
 * Pure and dependency-free so the copy can be unit-tested. When email
 * delivery is off, the server reports `link_only` / `emailDelivery: 'off'`
 * with shareable signup links; the UI must say so and hand over the links
 * instead of claiming an invite was sent.
 */

export function describeBulkInvites(data) {
  const links = (data.results || [])
    .filter((r) => r.status === 'link_only' && r.signupUrl)
    .map((r) => ({ email: r.email, signupUrl: r.signupUrl }));
  const parts = [];
  if (data.sent > 0) parts.push(`${data.sent} ${data.sent === 1 ? 'invite' : 'invites'} sent`);
  if (data.linkOnly > 0) parts.push('Email delivery is off — copy each invite link and share it yourself');
  if (data.skipped > 0) parts.push(`${data.skipped} skipped`);
  return { text: `${parts.join('. ')}.`, links };
}

export function describeSingleInvite(email, data) {
  if (data?.emailDelivery === 'off') {
    return {
      text: `Email delivery is off — copy the invite link for ${email} and share it yourself.`,
      links: data.signupUrl ? [{ email, signupUrl: data.signupUrl }] : [],
    };
  }
  return { text: `Invite sent to ${email}.`, links: [] };
}

export function describeAdminReset(email, data) {
  if (data?.emailDelivery === 'off') {
    return 'Email delivery is off, so no reset email was sent.';
  }
  return `Password reset email sent to ${email}.`;
}
