/**
 * An external sign-in creates an account in one of the classroom's groups
 * only (src/lib/external-auth.js), as password signup does: messages and
 * admin filters match groups by name, so an unknown name strands the person.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.SKIP_EMAIL = 'true';
const { default: db } = await import('../../src/lib/db.js');
const { completeExternalAuth } = await import('../../src/lib/external-auth.js');

const identity = (email) => ({ provider: 'google', subject: `sub-${email}`, email, emailVerified: true, name: 'Ext Learner' });
let n = 0;
async function invite(profile = null) {
  const email = `ext-${++n}@example.test`;
  await db.createInvite({ inviteToken: `inv_ext_${n}`, email, invitedBy: 'usr_owner', ...(profile ? { profile } : {}) });
  return email;
}

beforeEach(async () => {
  if (await db.countUsers() === 0) await db.createUser({ userId: 'usr_owner', email: 'owner@example.test', passwordHash: 'x', role: 'admin', name: 'Owner' });
  const settings = await db.getSyncData('_system', 'settings');
  await db.putSyncData('_system', 'settings', { ...(settings?.data || {}), userGroups: ['Cohort A', 'Cohort B'] }, settings?.version || 0);
});

describe('external sign-in groups', () => {
  it('ignores a group the classroom does not have, falling back to the invitation’s', async () => {
    const email = await invite({ userGroup: 'Cohort B' });
    const r = await completeExternalAuth(identity(email), { userGroup: 'Made Up' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await db.getUserByEmail(email)).userGroup, 'Cohort B');

    const bare = await invite();
    await completeExternalAuth(identity(bare), { userGroup: 'Made Up' });
    assert.equal((await db.getUserByEmail(bare)).userGroup, null);
  });

  it('keeps a valid group the person chose', async () => {
    const email = await invite({ userGroup: 'Cohort B' });
    await completeExternalAuth(identity(email), { userGroup: 'Cohort A' });
    assert.equal((await db.getUserByEmail(email)).userGroup, 'Cohort A');
  });
});
