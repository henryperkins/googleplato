import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

// Configure for SQLite before importing
const TEST_DB_PATH = './data/test-db-sqlite.db';
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = TEST_DB_PATH;

const { default: db } = await import('../../src/lib/db-sqlite.js');

// Clean up test DB after all tests
after(() => {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  // WAL files
  if (existsSync(TEST_DB_PATH + '-wal')) unlinkSync(TEST_DB_PATH + '-wal');
  if (existsSync(TEST_DB_PATH + '-shm')) unlinkSync(TEST_DB_PATH + '-shm');
});

describe('db-sqlite', () => {
  describe('users', () => {
    const userId = `usr_test_${Date.now()}`;

    it('creates and retrieves a user', async () => {
      await db.createUser({
        userId,
        email: 'Test@Example.com',
        username: 'testuser',
        passwordHash: '$2a$12$fake',
        name: 'Test User',
        role: 'user',
      });

      const user = await db.getUserById(userId);
      assert.equal(user.userId, userId);
      assert.equal(user.email, 'test@example.com'); // lowercase
      assert.equal(user.username, 'testuser');
      assert.equal(user.name, 'Test User');
      assert.equal(user.role, 'user');
    });

    it('round-trips customFields as an object', async () => {
      const id = `usr_cf_${Date.now()}`;
      await db.createUser({
        userId: id, email: `cf-${Date.now()}@example.com`, passwordHash: 'x', name: 'CF', role: 'user',
        customFields: { fld_org: 'UIC' },
      });
      assert.deepEqual((await db.getUserById(id)).customFields, { fld_org: 'UIC' });
      await db.updateUser(id, { customFields: { fld_org: 'UIC', fld_bio: 'Hi' } });
      assert.deepEqual((await db.getUserById(id)).customFields, { fld_org: 'UIC', fld_bio: 'Hi' });
      const listed = (await db.listAllUsers()).find((u) => u.userId === id);
      assert.deepEqual(listed.customFields, { fld_org: 'UIC', fld_bio: 'Hi' });
    });

    it('removeUserCustomField removes only that key', async () => {
      const id = `usr_cfr_${Date.now()}`;
      await db.createUser({
        userId: id, email: `cfr-${Date.now()}@example.com`, passwordHash: 'x', name: 'CF', role: 'user',
        customFields: { fld_a: '1', fld_b: '2' },
      });
      await db.removeUserCustomField(id, 'fld_a');
      assert.deepEqual((await db.getUserById(id)).customFields, { fld_b: '2' });
      // No-op for a user without customFields.
      const bare = `usr_cfn_${Date.now()}`;
      await db.createUser({ userId: bare, email: `cfn-${Date.now()}@example.com`, passwordHash: 'x', name: 'N', role: 'user' });
      await db.removeUserCustomField(bare, 'fld_a');
      assert.equal((await db.getUserById(bare)).customFields, null);
    });

    it('retrieves user by email (case-insensitive)', async () => {
      const user = await db.getUserByEmail('TEST@example.COM');
      assert.equal(user.userId, userId);
    });

    it('retrieves user by username (case-insensitive)', async () => {
      const user = await db.getUserByUsername('TESTUSER');
      assert.equal(user.userId, userId);
    });

    it('rejects duplicate userId', async () => {
      await assert.rejects(() => db.createUser({
        userId,
        email: 'other@example.com',
        passwordHash: '$2a$12$fake',
        name: 'Dup',
        role: 'user',
      }), { name: 'ConditionalCheckFailedException' });
    });

    it('updates user fields', async () => {
      await db.updateUser(userId, { name: 'Updated Name', userGroup: 'Test Org' });
      const user = await db.getUserById(userId);
      assert.equal(user.name, 'Updated Name');
      assert.equal(user.userGroup, 'Test Org');
    });

    it('counts users', async () => {
      const count = await db.countUsers();
      assert.ok(count >= 1);
    });

    it('lists users', async () => {
      const list = await db.listUsers();
      assert.ok(list.some(u => u.userId === userId));
    });

    it('deletes a user', async () => {
      await db.deleteUser(userId);
      const user = await db.getUserById(userId);
      assert.equal(user, null);
    });
  });

  describe('invites', () => {
    const token = `inv_test_${Date.now()}`;

    it('creates and retrieves an invite', async () => {
      await db.createInvite({
        inviteToken: token,
        email: 'invite@test.com',
        invitedBy: 'usr_admin',
      });

      const invite = await db.getInvite(token);
      assert.equal(invite.inviteToken, token);
      assert.equal(invite.status, 'pending');
    });

    it('finds invite by email', async () => {
      const invite = await db.getInviteByEmail('invite@test.com');
      assert.equal(invite.inviteToken, token);
    });

    it('marks invite as used', async () => {
      await db.markInviteUsed(token);
      const invite = await db.getInvite(token);
      assert.equal(invite.status, 'used');
    });

    it('lists all invites', async () => {
      const list = await db.listInvites();
      assert.ok(list.some(i => i.inviteToken === token));
    });

    it('deletes an invite', async () => {
      await db.deleteInvite(token);
      assert.equal(await db.getInvite(token), null);
    });
  });

  describe('wait list (#363)', () => {
    const token = `inv_wl_${Date.now()}`;
    const profile = { name: 'Wait Person', userGroup: 'Cohort A', customFields: { fld_1: 'x' } };

    it('stores an entry with its profile and no ttl', async () => {
      await db.createWaitlistEntry({ inviteToken: token, email: 'Wait@Test.com', profile });
      const entry = await db.getInvite(token);
      assert.equal(entry.status, 'waitlist');
      assert.equal(entry.email, 'wait@test.com');
      assert.equal(entry.ttl, null);
      assert.deepEqual(entry.profile, profile);
    });

    it('finds an entry by email, but not as a pending invite', async () => {
      assert.equal((await db.getWaitlistEntryByEmail('wait@test.com')).inviteToken, token);
      assert.equal(await db.getInviteByEmail('wait@test.com'), null);
    });

    it('edits an entry in place, only while it is still an entry', async () => {
      const t = `inv_wle_${Date.now()}`;
      await db.createWaitlistEntry({ inviteToken: t, email: 'edit-me@test.com', profile });
      const next = { ...profile, name: 'Edited' };
      await db.updateWaitlistEntry(t, { email: 'Edited@Test.com', profile: next });
      const got = await db.getInvite(t);
      assert.equal(got.email, 'edited@test.com');
      assert.deepEqual(got.profile, next);
      await assert.rejects(db.updateWaitlistEntry('inv_missing', { email: 'x@test.com', profile }), { name: 'ConditionalCheckFailedException' });
    });

    it('replaces an entry\'s profile', async () => {
      const next = { ...profile, customFields: {} };
      await db.setInviteProfile(token, next);
      assert.deepEqual((await db.getInvite(token)).profile, next);
      await db.setInviteProfile(token, profile);
    });

    it('keeps a profile on a pending invite', async () => {
      const inv = `inv_wlp_${Date.now()}`;
      await db.createInvite({ inviteToken: inv, email: 'p@test.com', invitedBy: 'usr_admin', profile });
      assert.deepEqual((await db.getInvite(inv)).profile, profile);
      assert.deepEqual((await db.listInvites()).find(i => i.inviteToken === inv).profile, profile);
      await db.deleteInvite(inv);
    });
  });

  describe('refresh tokens', () => {
    const hash = 'testhash_' + Date.now();

    it('stores and retrieves a refresh token', async () => {
      await db.storeRefreshToken(hash, 'usr_test');
      const token = await db.getRefreshToken(hash);
      assert.equal(token.userId, 'usr_test');
      assert.equal(token.type, 'refresh');
    });

    it('deletes a refresh token', async () => {
      await db.deleteRefreshToken(hash);
      assert.equal(await db.getRefreshToken(hash), null);
    });
  });

  describe('reset tokens', () => {
    const hash = 'resethash_' + Date.now();

    it('stores and retrieves a reset token', async () => {
      await db.storeResetToken(hash, 'usr_test');
      const token = await db.getResetToken(hash);
      assert.equal(token.userId, 'usr_test');
      assert.equal(token.type, 'reset');
    });

    it('returns null for non-reset tokens via getResetToken', async () => {
      const refreshHash = 'refresh_' + Date.now();
      await db.storeRefreshToken(refreshHash, 'usr_test');
      assert.equal(await db.getResetToken(refreshHash), null);
      await db.deleteRefreshToken(refreshHash);
    });

    it('deletes a reset token', async () => {
      await db.deleteResetToken(hash);
      assert.equal(await db.getResetToken(hash), null);
    });
  });

  describe('token hardening (SEC-2, SEC-3)', () => {
    it('preserves the credential version on refresh token consumption', async () => {
      await db.storeRefreshToken('versioned-refresh', 'usr_test', 'credential-version');
      assert.equal((await db.consumeRefreshToken('versioned-refresh')).credentialVersion, 'credential-version');
    });

    const expire = (tokenHash) => {
      const raw = new Database(TEST_DB_PATH);
      raw.prepare('UPDATE refresh_tokens SET ttl = 1 WHERE tokenHash = ?').run(tokenHash);
      raw.close();
    };

    it('rejects a reset token as a refresh token', async () => {
      const h = 'sec2_reset_' + Date.now();
      await db.storeResetToken(h, 'usr_test');
      assert.equal(await db.getRefreshToken(h), null);
      assert.equal(await db.consumeRefreshToken(h), null);
      await db.deleteResetToken(h);
    });

    it('rejects expired refresh and reset tokens', async () => {
      const refreshHash = 'sec2_exp_refresh_' + Date.now();
      const resetHash = 'sec2_exp_reset_' + Date.now();
      await db.storeRefreshToken(refreshHash, 'usr_test');
      await db.storeResetToken(resetHash, 'usr_test');
      expire(refreshHash);
      expire(resetHash);
      assert.equal(await db.getRefreshToken(refreshHash), null);
      assert.equal(await db.getResetToken(resetHash), null);
      assert.equal(await db.consumeRefreshToken(refreshHash), null);
      assert.equal(await db.consumeResetToken(resetHash), null);
    });

    it('consumes a token exactly once, even concurrently', async () => {
      const h = 'sec3_consume_' + Date.now();
      await db.storeRefreshToken(h, 'usr_test');
      const results = await Promise.all([db.consumeRefreshToken(h), db.consumeRefreshToken(h)]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(await db.consumeRefreshToken(h), null);
      assert.equal(await db.getRefreshToken(h), null);
    });

    it('revokes all tokens for one user only', async () => {
      const a = 'sec3_revoke_a_' + Date.now();
      const b = 'sec3_revoke_b_' + Date.now();
      const other = 'sec3_revoke_other_' + Date.now();
      await db.storeRefreshToken(a, 'usr_revoke');
      await db.storeResetToken(b, 'usr_revoke');
      await db.storeRefreshToken(other, 'usr_keep');
      await db.revokeUserTokens('usr_revoke');
      assert.equal(await db.getRefreshToken(a), null);
      assert.equal(await db.getResetToken(b), null);
      assert.equal((await db.getRefreshToken(other)).userId, 'usr_keep');
      await db.deleteRefreshToken(other);
    });
  });

  describe('sync data', () => {
    const userId = 'usr_sync_test';

    it('puts and gets sync data', async () => {
      const result = await db.putSyncData(userId, 'profile', { name: 'Blake' }, 0);
      assert.equal(result.version, 1);

      const item = await db.getSyncData(userId, 'profile');
      assert.deepEqual(item.data, { name: 'Blake' });
      assert.equal(item.version, 1);
    });

    it('increments version on update', async () => {
      const result = await db.putSyncData(userId, 'profile', { name: 'Blake Updated' }, 1);
      assert.equal(result.version, 2);
    });

    it('rejects version conflict', async () => {
      await assert.rejects(
        () => db.putSyncData(userId, 'profile', { name: 'Conflict' }, 999),
        { name: 'ConditionalCheckFailedException' }
      );
    });

    it('strict authoring writes cannot replace a concurrent creation or recreate a deletion', async () => {
      await db.putSyncData(userId, 'lesson:strict', { name: 'First' }, 0, { strictVersion: true });
      await assert.rejects(
        db.putSyncData(userId, 'lesson:strict', { name: 'Stale creator' }, 0, { strictVersion: true }),
        { name: 'ConditionalCheckFailedException' }
      );
      assert.equal((await db.getSyncData(userId, 'lesson:strict')).data.name, 'First');
      await db.deleteSyncData(userId, 'lesson:strict');
      await assert.rejects(
        db.putSyncData(userId, 'lesson:strict', { name: 'Deleted' }, 1, { strictVersion: true }),
        { name: 'ConditionalCheckFailedException' }
      );
    });

    it('gets all sync data for a user', async () => {
      await db.putSyncData(userId, 'preferences', { name: 'Test' }, 0);
      const all = await db.getAllSyncData(userId);
      assert.ok(all.length >= 2);
      assert.ok(all.some(i => i.dataKey === 'profile'));
      assert.ok(all.some(i => i.dataKey === 'preferences'));
    });

    it('gets only records matching a dataKey prefix', async () => {
      await db.putSyncData(userId, 'lessonKB:l1', { status: 'completed' }, 0);
      await db.putSyncData(userId, 'lessonKB:l2', { status: 'active' }, 0);
      await db.putSyncData(userId, 'screenshot:s1', { blob: 'big' }, 0);
      const kb = await db.getSyncDataByPrefix(userId, 'lessonKB:');
      assert.equal(kb.length, 2);
      assert.ok(kb.every(i => i.dataKey.startsWith('lessonKB:')));
      assert.ok(!kb.some(i => i.dataKey.startsWith('screenshot:')));
      assert.deepEqual(kb.find(i => i.dataKey === 'lessonKB:l1').data, { status: 'completed' });
    });

    it('deletes sync data', async () => {
      await db.deleteSyncData(userId, 'preferences');
      assert.equal(await db.getSyncData(userId, 'preferences'), null);
    });

    it('excludes prefixes in getAllSyncData without returning excluded rows', async () => {
      await db.putSyncData(userId, 'screenshot:keep-out', { blob: 'big' }, 0);
      await db.putSyncData(userId, 'userMeta:plugin', { note: 'admin' }, 0);
      const all = await db.getAllSyncData(userId, { excludePrefixes: ['screenshot:', 'userMeta:'] });
      assert.ok(all.some(i => i.dataKey === 'profile'));
      assert.ok(!all.some(i => i.dataKey.startsWith('screenshot:')));
      assert.ok(!all.some(i => i.dataKey.startsWith('userMeta:')));
    });

    it('treats excluded prefixes literally, not as LIKE patterns', async () => {
      await db.putSyncData(userId, 'literal_%:a', [], 0);
      await db.putSyncData(userId, 'literal_other:a', [], 0);
      const all = await db.getAllSyncData(userId, { excludePrefixes: ['literal_%:'] });
      assert.ok(!all.some(i => i.dataKey === 'literal_%:a'));
      assert.ok(all.some(i => i.dataKey === 'literal_other:a'));
    });

    it('reads one prefix across all users in a single bulk call', async () => {
      await db.putSyncData('usr_bulk_b', 'lessonKB:l1', { status: 'completed' }, 0);
      await db.putSyncData('usr_bulk_b', 'screenshot:s9', { blob: 'big' }, 0);
      const items = await db.getSyncDataByPrefixForAllUsers('lessonKB:');
      const mine = items.filter(i => i.userId === userId || i.userId === 'usr_bulk_b');
      assert.ok(mine.some(i => i.userId === userId && i.dataKey === 'lessonKB:l1'));
      assert.ok(mine.some(i => i.userId === 'usr_bulk_b' && i.dataKey === 'lessonKB:l1'));
      assert.ok(items.every(i => i.dataKey.startsWith('lessonKB:')));
    });

    it('deleteAllSyncData removes every row for one user only', async () => {
      await db.deleteAllSyncData(userId);
      assert.deepEqual(await db.getAllSyncData(userId), []);
      assert.ok((await db.getAllSyncData('usr_bulk_b')).some(i => i.dataKey === 'lessonKB:l1'));
      await db.deleteAllSyncData('usr_bulk_b');
    });
  });

  describe('audit log', () => {
    it('creates an audit log entry', async () => {
      await db.createAuditLog({
        action: 'user_deleted',
        userId: 'usr_deleted',
        email: 'deleted@test.com',
        performedBy: 'usr_admin',
        details: { reason: 'test' },
      });
      // No retrieval API exists — just verify it doesn't throw
    });
  });
});
