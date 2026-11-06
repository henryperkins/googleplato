import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isDeepStrictEqual } from 'node:util';
import { createPostgresDatabase } from '../../src/lib/postgres-database.js';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { default: sqlite } = await import('../../src/lib/db-sqlite.js');
const { acceptInvite } = await import('../../src/lib/account-invites.js');
const { default: dynamo, setDocumentClientForTests } = await import('../../src/lib/db-dynamodb.js');

const settings = { userGroups: ['Invited'], userFields: [
  { id: 'org', type: 'text', label: 'Organization' },
  { id: 'team', type: 'text', label: 'Team' },
] };
const profile = { name: 'Ignored name', userGroup: 'Invited', customFields: { org: 'Invite org', team: 'Invite team' } };

async function qualify(t, db, writer = db) {
  async function setup(customFields = { extra: 'Original extra' }) {
    const userId = randomUUID();
    await db.createUser({ userId, email: `${userId}@example.test`, name: 'Learner name', firstName: 'Learner', lastName: 'Name', nameSource: 'user', role: 'learner', passwordHash: 'original-hash', customFields });
    const user = await db.getUserById(userId);
    await db.createInvite({ inviteToken: userId, forUserId: userId, email: user.email, invitedBy: 'admin', profile });
    const audits = [];
    const wrapped = Object.create(db);
    wrapped.getSyncData = async () => ({ data: settings });
    wrapped.createAuditLog = async audit => { audits.push(audit); };
    return { user, wrapped, audits };
  }

  await t.test('a null custom map can be filled without changing names or credentials', async () => {
    const { user, wrapped, audits } = await setup(null);
    assert.deepEqual(await acceptInvite(user, user.userId, { db: wrapped }), { userGroup: 'Invited', fields: ['org', 'team'] });
    const saved = await db.getUserById(user.userId);
    assert.deepEqual(saved.customFields, { org: 'Invite org', team: 'Invite team' });
    assert.equal(saved.name, 'Learner name');
    assert.equal(saved.firstName, 'Learner');
    assert.equal(saved.lastName, 'Name');
    assert.equal(saved.nameSource, 'user');
    assert.equal(saved.passwordHash, 'original-hash');
    assert.equal(saved.role, 'learner');
    assert.deepEqual(audits[0].details.fields, ['org', 'team']);
  });

  await t.test('stale authentication cannot overwrite newer profile answers or group', async () => {
    const { user, wrapped, audits } = await setup();
    await writer.updateUser(user.userId, { userGroup: 'Admin group', customFields: { org: 'Learner org', extra: 'Admin extra' }, role: 'educator', passwordHash: 'new-hash', name: 'Admin name' });
    assert.deepEqual(await acceptInvite(user, user.userId, { db: wrapped }), { userGroup: null, fields: ['team'] });
    const saved = await db.getUserById(user.userId);
    assert.deepEqual(saved.customFields, { org: 'Learner org', extra: 'Admin extra', team: 'Invite team' });
    assert.equal(saved.userGroup, 'Admin group');
    assert.equal(saved.role, 'educator');
    assert.equal(saved.passwordHash, 'new-hash');
    assert.equal(saved.name, 'Admin name');
    assert.deepEqual(audits[0].details.fields, ['team']);
    assert.equal(audits[0].details.userGroup, null);
    assert.equal((await db.getInvite(user.userId)).status, 'used');
  });

  await t.test('edit after the fresh read forces retry and preserves all concurrent answers', async () => {
    const { user, wrapped, audits } = await setup();
    let reads = 0;
    wrapped.getUserById = async (...args) => {
      const current = await db.getUserById(...args);
      if (++reads === 1) await writer.updateUser(user.userId, { userGroup: 'Racing group', customFields: { org: 'Racing org', extra: 'Racing extra' } });
      return current;
    };
    assert.deepEqual(await acceptInvite(user, user.userId, { db: wrapped }), { userGroup: null, fields: ['team'] });
    assert.ok(reads >= 2);
    assert.deepEqual((await db.getUserById(user.userId)).customFields, { org: 'Racing org', extra: 'Racing extra', team: 'Invite team' });
    assert.deepEqual(audits[0].details.fields, ['team']);
    assert.equal(audits[0].details.userGroup, null);
  });

  await t.test('CAS rejects stale snapshots and deleted accounts without recreating them', async () => {
    const { user } = await setup();
    await writer.updateUser(user.userId, { customFields: { extra: 'Changed' } });
    assert.equal(await db.updateUserProfileIf(user.userId, user, { userGroup: 'Invited', customFields: { org: 'Wrong' } }), false);
    const current = await db.getUserById(user.userId);
    await writer.deleteUser(user.userId);
    assert.equal(await db.updateUserProfileIf(user.userId, current, { userGroup: 'Invited' }), false);
    assert.ok(!(await db.getUserById(user.userId)));
  });

  await t.test('CAS protects a group-only edit independently of custom answers', async () => {
    const { user } = await setup();
    await writer.updateUser(user.userId, { userGroup: 'Admin group' });
    assert.equal(await db.updateUserProfileIf(user.userId, user, { userGroup: 'Invited' }), false);
    assert.equal((await db.getUserById(user.userId)).userGroup, 'Admin group');
  });

  await t.test('CAS preserves unrelated account edits without rejecting a valid profile merge', async () => {
    const { user } = await setup();
    await writer.updateUser(user.userId, { role: 'educator', passwordHash: 'new-hash', name: 'New name' });
    assert.equal(await db.updateUserProfileIf(user.userId, user, { userGroup: 'Invited' }), true);
    const saved = await db.getUserById(user.userId);
    assert.equal(saved.userGroup, 'Invited');
    assert.equal(saved.role, 'educator');
    assert.equal(saved.passwordHash, 'new-hash');
    assert.equal(saved.name, 'New name');
    assert.equal(saved.firstName, 'Learner');
    assert.equal(saved.lastName, 'Name');
    assert.equal(saved.nameSource, 'user');
    assert.deepEqual(saved.customFields, { extra: 'Original extra' });
  });

  await t.test('an already filled profile records no applied changes and preserves updatedAt', async () => {
    const { user, wrapped, audits } = await setup();
    await writer.updateUser(user.userId, { userGroup: 'Existing', customFields: { org: 'Existing', team: 'Existing' } });
    const before = await db.getUserById(user.userId);
    assert.deepEqual(await acceptInvite(user, user.userId, { db: wrapped }), { userGroup: null, fields: [] });
    assert.equal((await db.getUserById(user.userId)).updatedAt, before.updatedAt);
    assert.deepEqual(audits[0].details.fields, []);
    assert.equal(audits[0].details.userGroup, null);
  });

  await t.test('deleted account leaves the invite available and emits no acceptance audit', async () => {
    const { user, wrapped, audits } = await setup();
    await writer.deleteUser(user.userId);
    assert.deepEqual(await acceptInvite(user, user.userId, { db: wrapped }), { error: 'Account not found', status: 404 });
    assert.equal((await db.getInvite(user.userId)).status, 'pending');
    assert.deepEqual(audits, []);
  });

  await t.test('persistence errors leave the invite available and emit no acceptance audit', async () => {
    const { user, wrapped, audits } = await setup();
    wrapped.updateUserProfileIf = async () => { throw new Error('Persistence unavailable'); };
    await assert.rejects(acceptInvite(user, user.userId, { db: wrapped }), /Persistence unavailable/);
    assert.equal((await db.getInvite(user.userId)).status, 'pending');
    assert.deepEqual(audits, []);
  });

  await t.test('continuous contention stops with a retryable conflict and pending invite', async () => {
    const { user, wrapped, audits } = await setup();
    let writes = 0;
    wrapped.updateUserProfileIf = async () => { writes++; return false; };
    const result = await acceptInvite(user, user.userId, { db: wrapped });
    assert.equal(result.status, 409);
    assert.match(result.error, /changed|retry/i);
    assert.ok(writes > 1 && writes <= 5);
    assert.equal((await db.getInvite(user.userId)).status, 'pending');
    assert.deepEqual(audits, []);
  });
}

test('atomic account invite acceptance on SQLite', async t => qualify(t, sqlite));
test('atomic account invite acceptance on PostgreSQL', { skip: !process.env.POSTGRES_TEST_URL }, async t => {
  const schema = `invite_atomic_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { connectionString: process.env.POSTGRES_TEST_URL, options: `-c search_path=${schema}` };
  const pool = new pg.Pool(options);
  const other = new pg.Pool(options);
  t.after(async () => { await Promise.all([pool.end(), other.end()]); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await qualify(t, await createPostgresDatabase(pool), await createPostgresDatabase(other));
});

// Only the AWS transport is replaced. Execute the adapter's actual conditional
// expressions against controlled documents; no network or AWS credentials.
class ProfileDocumentClient {
  constructor(item, beforeUpdate) { this.item = structuredClone(item); this.beforeUpdate = beforeUpdate; this.calls = []; }
  async send(command) {
    this.calls.push(command);
    const { ExpressionAttributeNames: names, ExpressionAttributeValues: values } = command.input;
    if (command instanceof GetCommand) return { Item: structuredClone(this.item) };
    assert.ok(command instanceof UpdateCommand);
    if (this.beforeUpdate) { const edit = this.beforeUpdate; this.beforeUpdate = null; edit(this); }
    assert.ok(command.input.ConditionExpression, 'a profile write must be conditional');
    const predicates = command.input.ConditionExpression.split(' AND ');
    const matches = predicates.every(predicate => {
      const exists = predicate.match(/^attribute_exists\((#[a-zA-Z]+)\)$/);
      if (exists) return this.item && Object.hasOwn(this.item, names[exists[1]]);
      const absent = predicate.match(/^attribute_not_exists\((#[a-zA-Z]+)\)$/);
      if (absent) return !this.item || !Object.hasOwn(this.item, names[absent[1]]);
      const equal = predicate.match(/^(#[a-zA-Z]+) = (:[a-zA-Z]+)$/);
      assert.ok(equal, `unsupported condition: ${predicate}`);
      return this.item && Object.hasOwn(this.item, names[equal[1]]) && isDeepStrictEqual(this.item[names[equal[1]]], values[equal[2]]);
    });
    if (!matches) throw Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' });
    for (const assignment of command.input.UpdateExpression.replace(/^SET /, '').split(', ')) {
      const [key, value] = assignment.split(' = ');
      this.item[names[key]] = structuredClone(values[value]);
    }
    return {};
  }
}

test('DynamoDB profile CAS preserves concurrent edits and never recreates a deleted account', async t => {
  const original = { userId: 'u', userGroup: null, customFields: { extra: 'Original' }, role: 'learner', name: 'Learner', passwordHash: 'hash' };
  for (const initial of [original, { ...original, customFields: null }, { userId: 'u', name: 'Legacy' }]) {
    await t.test(`fills profile with ${initial.customFields === null ? 'null' : initial.customFields ? 'present' : 'absent'} map`, async () => {
      const fake = new ProfileDocumentClient(initial);
      setDocumentClientForTests(fake);
      assert.equal(await dynamo.updateUserProfileIf('u', initial, { userGroup: 'Invited', customFields: { ...initial.customFields, org: 'Invite org' } }), true);
      assert.equal(fake.item.userGroup, 'Invited');
      assert.equal(fake.item.customFields.org, 'Invite org');
      assert.equal(fake.item.name, initial.name);
      assert.equal(fake.item.passwordHash, initial.passwordHash);
    });
  }
  await t.test('a change after read defeats CAS and a recomputed retry preserves it', async () => {
    const fake = new ProfileDocumentClient(original, client => { client.item.customFields = { extra: 'Concurrent', org: 'Learner org' }; client.item.userGroup = 'Admin group'; });
    setDocumentClientForTests(fake);
    assert.equal(await dynamo.updateUserProfileIf('u', original, { userGroup: 'Invited', customFields: { extra: 'Original', org: 'Invite org' } }), false);
    const current = await dynamo.getUserById('u', { consistentRead: true });
    assert.equal(fake.calls.at(-1).input.ConsistentRead, true);
    assert.equal(await dynamo.updateUserProfileIf('u', current, { customFields: { ...current.customFields, team: 'Invite team' } }), true);
    assert.deepEqual(fake.item.customFields, { extra: 'Concurrent', org: 'Learner org', team: 'Invite team' });
    assert.equal(fake.item.userGroup, 'Admin group');
  });
  await t.test('deletion before update is a failed CAS', async () => {
    // Both profile attributes were absent: only account existence prevents
    // the two attribute_not_exists predicates from recreating this account.
    const legacy = { userId: 'u' };
    const fake = new ProfileDocumentClient(legacy, client => { client.item = undefined; });
    setDocumentClientForTests(fake);
    assert.equal(await dynamo.updateUserProfileIf('u', legacy, { userGroup: 'Invited' }), false);
    assert.equal(fake.item, undefined);
  });
  await t.test('nonconditional AWS failures propagate', async () => {
    setDocumentClientForTests({ send: async () => { throw new Error('AWS unavailable'); } });
    await assert.rejects(dynamo.updateUserProfileIf('u', original, { userGroup: 'Invited' }), /AWS unavailable/);
  });
});


test('DynamoDB acceptance recomputes applied changes after transport-level contention', async () => {
  const original = { userId: 'u', email: 'learner@example.test', role: 'learner', userGroup: null, customFields: { extra: 'Original' } };
  const fake = new ProfileDocumentClient(original, client => {
    client.item.userGroup = 'Admin group';
    client.item.customFields = { extra: 'Concurrent', org: 'Learner org' };
  });
  setDocumentClientForTests(fake);
  const audits = [];
  let used = false;
  const wrapped = Object.create(dynamo);
  wrapped.getInvite = async () => ({ inviteToken: 'inv', forUserId: 'u', status: 'pending', profile });
  wrapped.getSyncData = async () => ({ data: settings });
  wrapped.markInviteUsed = async () => { used = true; };
  wrapped.createAuditLog = async audit => { audits.push(audit); };
  assert.deepEqual(await acceptInvite(original, 'inv', { db: wrapped }), { userGroup: null, fields: ['team'] });
  assert.deepEqual(fake.item.customFields, { extra: 'Concurrent', org: 'Learner org', team: 'Invite team' });
  assert.equal(fake.item.userGroup, 'Admin group');
  assert.equal(used, true);
  assert.deepEqual(audits[0].details.fields, ['team']);
  assert.equal(audits[0].details.userGroup, null);
  const reads = fake.calls.filter(command => command instanceof GetCommand);
  assert.ok(reads.length >= 2);
  assert.ok(reads.every(command => command.input.ConsistentRead === true));
});
