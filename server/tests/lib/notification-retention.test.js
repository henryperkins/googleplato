import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresDatabase } from '../../src/lib/postgres-database.js';
import { StaleDocumentClient } from '../helpers/stale-document-client.js';
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { default: sqlite } = await import('../../src/lib/db-sqlite.js');
const { default: dynamo, setDocumentClientForTests } = await import('../../src/lib/db-dynamodb.js');
const m = await import('../../src/lib/messages.js');
const { readNotifyState, writeAutomations, setEmailTransport } = await import('../../src/lib/notifications.js');
const { runInactivityNudges, runWeeklyDigest } = await import('../../src/lib/learner-emails.js');
const { logger } = await import('../../src/lib/logger.js');
const actor = { userId: 'admin', name: 'Admin' };
const user = { userId: 'reader', email: 'reader@example.test', name: 'Reader', role: 'learner' };
const draft = { subject: 'Message', body: 'Body', audience: { type: 'users', userIds: [user.userId] }, inApp: true, email: true };
const stamp = '2026-01-01T00:00:00.000Z';
const guards = { optOut: { nudge: true }, read: {}, nudges: { lesson: stamp }, lastNudgeAt: stamp, lastDigestAt: stamp };
const size = value => Buffer.byteLength(JSON.stringify(value));
const capped = db => ({ ...db, async putSyncData(uid, key, data, ...rest) {
  if (size({ userId: uid, dataKey: key, data, version: 100000, updatedAt: stamp }) > 400 * 1024) throw Object.assign(new Error('Item size exceeded'), { name: 'ValidationException' });
  return db.putSyncData(uid, key, data, ...rest);
} });
async function qualify(t, db) {
  await db.createUser?.({ ...user, passwordHash: 'x' });
  await t.test('8150 near-cap legacy failed receipts expire before the next delivery claim', async () => {
    const emailed = {};
    for (let i = 0; i < 8150; i++) {
      const id = `msg_${i.toString(36).padStart(11, '0')}`;
      emailed[id] = stamp;
      await db.createSyncData('_system', `message:${id}`, { ...draft, status: 'failed', createdAt: stamp });
    }
    const base = { ...guards, emailed, emailPending: {} };
    const room = 400 * 1024 - size({ userId: user.userId, dataKey: 'notify:state', data: base, version: 100000, updatedAt: stamp }) - 50;
    assert.ok(room > 0);
    base.legacy = 'x'.repeat(Math.max(0, room - 12));
    await db.createSyncData(user.userId, 'notify:state', base);
    assert.ok(size(base) > 399 * 1024 && size(base) < 400 * 1024);
    let calls = 0;
    const next = await m.createMessage(draft, actor, db);
    await db.settleReplica?.();
    await m.sendMessageEmails({ id: next.id }, { db: capped(db), send: async () => { calls++; } });
    assert.equal(calls, 1);
    const state = await readNotifyState(user.userId, db);
    assert.ok(Object.keys(state.emailed).length <= 49);
    assert.deepEqual(state.emailPending, {});
    for (const key of ['optOut', 'nudges', 'lastNudgeAt', 'lastDigestAt']) assert.deepEqual(state[key], guards[key]);
    assert.equal((await m.listMessages(db)).filter(message => message.status === 'closed').length, 8150);
  });
  await t.test('state size stays constant after 10 and 100 failed-then-closed messages', async () => {
    let baseline;
    for (let i = 0; i < 100; i++) {
      const message = await m.createMessage(draft, actor, db);
      await assert.rejects(m.sendMessageEmails({ id: message.id }, { db, send: async () => { throw Object.assign(new Error('Uncertain acknowledgement'), { name: 'TimeoutError' }); } }));
      assert.ok((await readNotifyState(user.userId, db)).emailPending[message.id]);
      await m.closeMessage(message.id, db);
      const state = await readNotifyState(user.userId, db);
      assert.equal(state.emailPending[message.id], undefined);
      if (i === 9) baseline = size(state);
      if (i === 99) assert.equal(size(state), baseline);
      let resent = 0;
      await m.sendMessageEmails({ id: message.id }, { db, send: async () => { resent++; } });
      assert.equal(resent, 0);
    }
  });
  await t.test('markRead accepts only exact visible IDs and prunes old reads while retaining guards', async () => {
    const foreign = await m.createMessage({ ...draft, audience: { type: 'users', userIds: ['foreign'] } }, actor, db);
    const own = await m.createMessage({ ...draft, email: false }, actor, db);
    const previous = await db.getSyncData(user.userId, 'notify:state', { consistentRead: true });
    await db.putSyncData(user.userId, 'notify:state', { ...previous.data, read: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`msg_obsolete${i.toString(36).padStart(4, '0')}`, stamp])) }, previous.version);
    assert.deepEqual(await m.markRead(user.userId, [foreign.id, 'msg_../bad', 'msg_short', `msg_${'a'.repeat(41)}`, own.id, own.id], db), { read: 1 });
    const state = await readNotifyState(user.userId, db);
    const visible = new Set((await m.messagesFor(user, db)).map(message => message.id));
    assert.ok(Object.keys(state.read).every(id => visible.has(id)));
    assert.equal(state.read[foreign.id], undefined);
    assert.equal(Object.keys(state.read).length, 1, '1000 old acknowledgements are pruned to the accepted visible message');
    assert.ok(state.read[own.id]);
    for (const key of ['optOut', 'nudges', 'lastNudgeAt', 'lastDigestAt']) assert.deepEqual(state[key], guards[key]);
  });
}
test('notification retention on real SQLite with a 400KB wrapper', async t => qualify(t, sqlite));
test('notification retention on real PostgreSQL 17 with a 400KB wrapper', { skip: !process.env.POSTGRES_TEST_URL }, async t => {
  const schema = `notify_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  assert.match((await admin.query('SHOW server_version')).rows[0].server_version, /^17\./);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await qualify(t, await createPostgresDatabase(pool));
});
test('notification retention through actual DynamoDB conditions and a capped stale-read fake', async t => {
  const doc = new StaleDocumentClient({ maxItemBytes: 400 * 1024 });
  setDocumentClientForTests(doc);
  await qualify(t, { ...dynamo, createUser: undefined, settleReplica: () => {
    for (const row of doc.rows.values()) row.previous = structuredClone(row.current);
  }, listAllUsers: async () => [user], getUserById: async id => id === user.userId ? user : null });
  assert.ok(doc.commands.some(command => command.input.ConditionExpression === 'version = :v'));
});
for (const [name, job, automation] of [['nudge', runInactivityNudges, 'inactivityNudge'], ['digest', runWeeklyDigest, 'weeklyDigest']]) {
  test(`${name} logs a learner's write failure and continues to later learners`, async t => {
    const first = { ...user, userId: `${name}_first` }, later = { ...user, userId: `${name}_later` };
    const now = Date.now() + 8 * 86400000;
    await writeAutomations({ [automation]: true }, sqlite);
    await sqlite.createSyncData('_system', `lesson:${name}`, { name: 'Practice', status: 'public', markdown: '# Practice', publishedAt: new Date(now).toISOString() });
    for (const person of [first, later]) await sqlite.createSyncData(person.userId, `lessonKB:${name}`, { status: 'active', progress: 2 });
    let sent = 0;
    setEmailTransport(async () => { sent++; });
    t.after(() => setEmailTransport(null));
    const errors = [], original = logger.error;
    logger.error = (code, meta) => errors.push({ code, meta });
    t.after(() => { logger.error = original; });
    const db = { ...sqlite, listAllUsers: async () => [first, later], createSyncData: async (uid, ...args) => {
      if (uid === first.userId) throw new Error('Controlled learner write failure');
      return sqlite.createSyncData(uid, ...args);
    } };
    const result = await job({ db, now });
    assert.equal(result.learners, 2);
    assert.equal(sent, 1);
    assert.ok(errors.some(error => error.meta.job === (name === 'nudge' ? 'inactivity-nudge' : 'weekly-digest') && /Controlled learner write failure/.test(error.meta.error)));
  });
}

for (const closure of ['admin', 'expiry']) test(`a late transport completion after ${closure} closure cannot reopen delivery or resend recipients`, async () => {
  const owner = { ...user, userId: `late_${closure}`, email: `late-${closure}@example.test` };
  await sqlite.createUser({ ...owner, passwordHash: 'x' });
  const message = await m.createMessage({ ...draft, audience: { type: 'users', userIds: [owner.userId] } }, actor, sqlite);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const sending = m.sendMessageEmails({ id: message.id }, { db: sqlite, send: async () => { calls++; started(); await gate; } }).catch(error => error);
  try {
    await reached;
    assert.deepEqual(await m.closeMessage(message.id, sqlite), { active: true }, 'an active lease cannot be closed');
    const item = await sqlite.getSyncData('_system', `message:${message.id}`);
    await sqlite.putSyncData('_system', `message:${message.id}`, { ...item.data, deliveryLease: { ...item.data.deliveryLease, until: 0 } }, item.version, { strictVersion: true });
    if (closure === 'admin') assert.equal((await m.closeMessage(message.id, sqlite)).status, 'closed');
    else {
      const expired = await sqlite.getSyncData('_system', `message:${message.id}`);
      await sqlite.putSyncData('_system', `message:${message.id}`, { ...expired.data, createdAt: stamp }, expired.version, { strictVersion: true });
      assert.equal((await m.listMessages(sqlite)).find(item => item.id === message.id).status, 'closed');
    }
    assert.equal((await readNotifyState(owner.userId, sqlite)).emailPending[message.id], undefined);
    release();
    assert.match((await sending).message, /ownership changed/);
    assert.equal((await sqlite.getSyncData('_system', `message:${message.id}`)).data.status, 'closed');
    assert.deepEqual(await m.sendMessageEmails({ id: message.id }, { db: sqlite, send: async () => { calls++; } }), { skipped: true });
    assert.equal(calls, 1);
  } finally { release(); await sending; }
});
