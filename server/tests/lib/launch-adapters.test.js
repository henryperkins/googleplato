import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresDatabase } from '../../src/lib/postgres-database.js';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { default: sqlite } = await import('../../src/lib/db-sqlite.js');
const { updateNotifyState, setOptOut } = await import('../../src/lib/notifications.js');
const { runDueJobs } = await import('../../src/lib/schedule.js');
const { createMessage, sendMessageEmails } = await import('../../src/lib/messages.js');

async function qualify(t, db) {
  await t.test('create-only writes have a single winner', async () => {
    const results = await Promise.allSettled([
      db.createSyncData('test', 'notify:state', { optOut: { messages: true } }),
      db.createSyncData('test', 'notify:state', { emailed: {} }),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.find(x => x.status === 'rejected').reason.name, 'ConditionalCheckFailedException');
    assert.equal(results.find(x => x.status === 'fulfilled').value.version, 1);
  });
  await t.test('names, account invites and conditional migrations persist atomically', async () => {
    await db.createUser({ userId: 'usr_names', email: 'names@example.test', passwordHash: 'hash', name: 'Mary Ann Evans', firstName: 'Mary Ann', lastName: 'Evans', nameSource: 'user', role: 'user' });
    const original = await db.getUserById('usr_names');
    assert.equal(original.firstName, 'Mary Ann');
    assert.equal(await db.setUserNameSplitIf('usr_names', original.name, { firstName: 'Mary', lastName: 'Ann Evans', nameSource: 'inferred' }), false);
    assert.equal(await db.setUserRoleIf('usr_names', 'learner', 'admin'), false);
    assert.equal(await db.setUserRoleIf('usr_names', 'user', 'learner'), true);
    assert.equal((await db.getUserById('usr_names')).updatedAt, original.updatedAt);
    await db.createInvite({ inviteToken: 'account', email: original.email, forUserId: original.userId });
    assert.equal((await db.getInviteByEmail(original.email)).forUserId, original.userId);
    await db.createUser({ userId: 'usr_inferred', email: 'inferred@example.test', passwordHash: 'hash', name: 'Ada Lovelace', role: 'learner' });
    const changes = await Promise.all([db.setUserNameSplitIf('usr_inferred', 'Ada Lovelace', { firstName: 'Ada', lastName: 'Lovelace', nameSource: 'inferred' }), db.setUserNameSplitIf('usr_inferred', 'Ada Lovelace', { firstName: 'Wrong', lastName: '', nameSource: 'inferred' })]);
    assert.equal(changes.filter(Boolean).length, 1);
  });
  await t.test('first opt-out survives a concurrent initial email claim', async () => {
    await Promise.all([setOptOut('race', { messages: true }, db), updateNotifyState('race', s => ({ ...s, emailed: { msg: 'now' } }), db)]);
    assert.equal((await db.getSyncData('race', 'notify:state')).data.optOut.messages, true);
  });
  await t.test('cold schedulers dispatch one daily job', async () => {
    await db.putSyncData('_system', 'automations', { inactivityNudge: true });
    const calls = [];
    await Promise.all(Array.from({ length: 2 }, () => runDueJobs({ db, now: new Date('2026-11-04T16:00:00Z'), force: true, dispatch: async job => { calls.push(job); return {}; } })));
    assert.deepEqual(calls, ['inactivity-nudge']);
  });
  await t.test('a failed recipient remains retryable without resending successful recipients', async () => {
    await db.createUser({ userId: 'usr_delivery_good', email: 'good@example.test', passwordHash: 'hash', name: 'Good', role: 'learner' });
    await db.createUser({ userId: 'usr_delivery_bad', email: 'bad@example.test', passwordHash: 'hash', name: 'Bad', role: 'learner' });
    const message = await createMessage({ subject: 'Test', body: 'Hello', email: true, inApp: true, audience: { type: 'users', userIds: ['usr_delivery_good', 'usr_delivery_bad'] } }, { userId: 'usr_actor', name: 'Admin' }, db);
    const sent = [];
    await assert.rejects(sendMessageEmails({ id: message.id }, { db, send: async raw => { if (raw.includes('To: bad@')) throw new Error('retryable transport failure'); sent.push(raw); } }), /delivery|recipient/i);
    assert.equal((await db.getSyncData('_system', `message:${message.id}`)).data.status, 'failed');
    await sendMessageEmails({ id: message.id }, { db, send: async raw => { sent.push(raw); } });
    assert.equal(sent.length, 2);
    assert.equal((await db.getSyncData('_system', `message:${message.id}`)).data.status, 'sent');
  });
}

test('launch contracts on SQLite', async t => qualify(t, sqlite));
test('launch contracts on PostgreSQL', { skip: !process.env.POSTGRES_TEST_URL }, async t => {
  const schema = `launch_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await qualify(t, await createPostgresDatabase(pool));
});

test('production launch refuses failed migrations and waits for a competing cold start', async () => {
  const { initializeLaunch } = await import('../../src/lib/launch.js');
  await assert.rejects(initializeLaunch({ migrate: async () => ({ ran: [{ result: { errors: 1 } }], skipped: null }) }), /migrations failed/);
  await assert.rejects(initializeLaunch({ migrate: async () => { throw new Error('database denied'); } }), /database denied/);
  await assert.rejects(initializeLaunch({ budgetMs: 0, migrate: async () => ({ ran: [], skipped: 'locked' }) }), /Timed out/);
  let calls = 0;
  await initializeLaunch({ migrate: async () => ({ ran: [], skipped: ++calls === 1 ? 'locked' : 'none_pending' }) });
  assert.equal(calls, 2);
});
