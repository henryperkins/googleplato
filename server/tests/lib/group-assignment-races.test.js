import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import pg from 'pg';
import { Hono } from 'hono';
import { StaleDocumentClient } from '../helpers/stale-document-client.js';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = `./data/group-races-${process.pid}.db`;
const { default: activeDb } = await import('../../src/lib/db.js');
const sqliteMethods = { ...activeDb };
const { default: dynamo, setDocumentClientForTests } = await import('../../src/lib/db-dynamodb.js');
const { createPostgresDatabase } = await import('../../src/lib/postgres-database.js');
const groups = await import('../../src/lib/groups.js');
const { completeExternalAuth } = await import('../../src/lib/external-auth.js');
const { acceptInvite } = await import('../../src/lib/account-invites.js');
const { default: auth } = await import('../../src/routes/auth.js');
const { default: admin } = await import('../../src/routes/admin.js');
const { default: me } = await import('../../src/routes/me.js');
const { signAccessToken } = await import('../../src/lib/jwt.js');
const { on } = await import('../../src/lib/plugins/hooks.js');
const { isRecipient } = await import('../../src/lib/messages.js');
const { logger } = await import('../../src/lib/logger.js');
const app = new Hono().route('/', auth).route('/', admin).route('/', me);
const gate = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const request = (method, path, token, body) => app.request(path, { method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}) });

for (const backend of ['sqlite', 'postgres', 'dynamodb']) {
  test(`${backend}: group assignment interleavings`, { skip: backend === 'postgres' && !process.env.POSTGRES_TEST_URL }, async t => {
    let db;
    let fake;
    let reset;
    if (backend === 'sqlite') {
      db = sqliteMethods;
      reset = async () => {
        for (const user of await db.listAllUsers()) await db.deleteUser(user.userId);
        for (const invite of await db.listInvites()) await db.deleteInvite(invite.inviteToken);
        for (const row of await db.getAllSyncData('_system')) await db.deleteSyncData('_system', row.dataKey);
      };
    } else if (backend === 'postgres') {
      const schema = `group_races_${randomUUID().replaceAll('-', '')}`;
      const owner = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
      await owner.query(`CREATE SCHEMA ${schema}`);
      const pool = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL, options: `-c search_path=${schema}` });
      db = await createPostgresDatabase(pool);
      reset = () => pool.query('TRUNCATE users, invites, sync_data, refresh_tokens, audit_log');
      t.after(async () => { await pool.end(); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); });
    } else {
      db = { ...dynamo };
      fake = new StaleDocumentClient();
      setDocumentClientForTests(fake);
      reset = async () => { fake.rows.clear(); fake.commands.length = 0; };
    }
    const install = () => Object.assign(activeDb, Object.fromEntries(Object.entries(db).map(([key, value]) => [key, typeof value === 'function' ? value.bind(db) : value])));
    t.after(() => Object.assign(activeDb, sqliteMethods));
    async function fixture(path) {
      await reset();
      install();
      logger._reset();
      await db.createUser({ userId: 'admin', email: 'admin@example.test', passwordHash: 'hash', name: 'Admin', role: 'admin' });
      await db.putSyncData('_system', 'settings', { userGroups: ['A', 'Keep'] }, 0);
      if (path === 'accept') await db.createUser({ userId: 'learner', email: 'learner@example.test', passwordHash: 'hash', name: 'Learner', role: 'learner' });
      await db.createInvite({ inviteToken: 'inv', email: 'learner@example.test', invitedBy: 'admin', profile: { userGroup: 'A' }, ...(path === 'accept' ? { forUserId: 'learner' } : {}) });
      await db.createSyncData('_system', 'message:existing', { audience: { type: 'group', group: 'A' } });
      fake?.commitReplicas();
    }
    const run = async path => {
      if (path === 'external') return completeExternalAuth({ provider: 'test', subject: 'subject', email: 'learner@example.test', emailVerified: true, name: 'Learner' }, { inviteToken: 'inv', userGroup: 'A' });
      if (path === 'password') {
        const response = await request('POST', '/v1/auth/signup', null, { inviteToken: 'inv', firstName: 'Learner', password: 'password123', userGroup: 'A' });
        return { status: response.status, body: await response.json() };
      }
      return acceptInvite(await db.getUserById('learner', { consistentRead: true }), 'inv');
    };
    const cleanup = action => action === 'delete' ? groups.deleteGroup('A', { db: activeDb }) : groups.renameGroup('A', 'B', { db: activeDb });
    async function finalAssertions(id, expected, hookGroups, path) {
      const account = await db.getUserById(id, { consistentRead: true });
      assert.equal(account.userGroup, expected);
      const settings = await db.getSyncData('_system', 'settings', { consistentRead: true });
      assert.ok(!account.userGroup || settings.data.userGroups.includes(account.userGroup));
      const response = await request('GET', '/v1/me', await signAccessToken(id, 'learner'));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).userGroup, expected, 'GET /me reads the final account');
      const listing = await request('GET', '/v1/admin/users', await signAccessToken('admin', 'admin'));
      assert.equal(listing.status, 200);
      const users = await listing.json();
      for (const group of ['A', 'B', 'Keep']) {
        assert.equal(users.filter(user => user.userGroup === group).some(user => user.userId === id), expected === group, `admin filter ${group}`);
        assert.equal(isRecipient({ audience: { type: 'group', group, allRoles: true } }, account), expected === group, `recipient ${group}`);
      }
      if (path !== 'accept') assert.equal(hookGroups.length, 1, 'userCreated completed and read actual account');
      const invites = await db.listInvites({ consistentRead: true });
      assert.equal(invites.find(inv => inv.inviteToken === 'inv').status, 'used');
    }
    for (const path of ['external', 'password', 'accept']) {
      for (const step of ['a', 'b', 'c']) for (const action of ['delete', 'rename']) {
        await t.test(`${path} (${step}) ${action}: W1/R1 vs W2/R2`, async () => {
          await fixture(path);
          const hookGroups = [];
          const off = on('userCreated', async ({ userId }) => { hookGroups.push((await db.getUserById(userId, { consistentRead: true })).userGroup); });
          const w2 = gate(); const writeAllowed = gate(); const r1 = gate(); const scanAllowed = gate(); const writeDone = gate(); const r2 = gate(); const checkAllowed = gate();
          let id = path === 'accept' ? 'learner' : null;
          let written = false;
          const method = path === 'accept' ? 'updateUserProfileIf' : 'createUser';
          const originalWrite = activeDb[method];
          const originalRead = activeDb.getUserById;
          const originalScan = activeDb.listAllUsers;
          activeDb[method] = async (...args) => {
            if (!written && (path === 'accept' ? args[2]?.userGroup === 'A' : args[0].email === 'learner@example.test')) {
              id = path === 'accept' ? args[0] : args[0].userId;
              w2.resolve();
              if (step !== 'c') await writeAllowed.promise;
              const result = await originalWrite(...args);
              written = true;
              writeDone.resolve();
              return result;
            }
            return originalWrite(...args);
          };
          activeDb.listAllUsers = async options => {
            if (step === 'b' && !written) { r1.resolve(); await scanAllowed.promise; }
            return originalScan(options);
          };
          activeDb.getUserById = async (...args) => {
            if (step === 'b' && written && args[0] === id && !checkAllowed.blocked) {
              checkAllowed.blocked = true; r2.resolve(); await checkAllowed.promise;
            }
            return originalRead(...args);
          };
          try {
            const admission = run(path);
            await w2.promise;
            let change;
            if (step === 'a') { await cleanup(action); writeAllowed.resolve(); }
            if (step === 'b') {
              change = cleanup(action);
              await r1.promise;
              writeAllowed.resolve();
              await writeDone.promise;
              await Promise.race([r2.promise, admission]);
              scanAllowed.resolve();
              await change;
              checkAllowed.resolve();
            }
            const result = await admission;
            assert.ok(path === 'accept' ? !result.error : result.status === 201, JSON.stringify(result));
            if (step === 'c') await cleanup(action);
            const expected = action === 'rename' && step !== 'a' ? 'B' : null;
            await finalAssertions(id, expected, hookGroups, path);
            const finalInvite = (await db.listInvites({ consistentRead: true })).find(inv => inv.inviteToken === 'inv');
            assert.equal(finalInvite.profile.userGroup, action === 'rename' ? 'B' : null, 'R1 scans the acknowledged invite profile');
            const message = await db.getSyncData('_system', 'message:existing', { consistentRead: true });
            assert.equal(message.data.audience.group, action === 'rename' ? 'B' : 'A', 'rename strongly scans group messages; deletion retains their address');
            if (step === 'a' && path !== 'accept') {
              const dropped = logger.recent().find(log => log.code === 'admission_group_dropped');
              assert.deepEqual(dropped?.meta, { group: 'A' }, 'only the stale group name is logged');
            }
            if (path !== 'accept') assert.equal(hookGroups[0], step === 'c' ? 'A' : expected, 'hook observes the settled account at its point in the interleaving');
            if (backend === 'dynamodb') {
              const scans = fake.commands.filter(command => ['ScanCommand', 'QueryCommand'].includes(command.constructor.name) && ['plato-users', 'plato-invites', 'plato-sync-data'].includes(command.input.TableName));
              for (const table of ['plato-users', 'plato-invites', 'plato-sync-data']) assert.ok(scans.some(command => command.input.TableName === table && command.input.ConsistentRead === true), `cleanup strongly reads ${table}`);
            }
          } finally { off(); install(); }
        });
      }
      await t.test(`${path} (d): R2 failure preserves admission, hook, invite and session`, async () => {
        await fixture(path);
        const hookGroups = [];
        const off = on('userCreated', async ({ userId }) => { hookGroups.push((await db.getUserById(userId, { consistentRead: true })).userGroup); });
        const writeMethod = path === 'accept' ? 'updateUserProfileIf' : 'createUser';
        const write = activeDb[writeMethod];
        const read = activeDb.getUserById;
        let written = false; let thrown = false; let id = 'learner';
        activeDb[writeMethod] = async (...args) => { const result = await write(...args); written = true; id = path === 'accept' ? args[0] : args[0].userId; return result; };
        activeDb.getUserById = async (...args) => {
          if (written && !thrown) { thrown = true; throw new Error('read failed with private@example.test'); }
          return read(...args);
        };
        try {
          const result = await run(path);
          assert.ok(path === 'accept' ? !result.error : result.status === 201, JSON.stringify(result));
          assert.equal(thrown, true, 'post-write read was attempted');
          if (path !== 'accept') { assert.ok(result.body.accessToken); assert.ok(result.body.refreshToken); }
          await finalAssertions(id, 'A', hookGroups, path);
          const logs = logger.recent();
          assert.ok(logs.some(log => log.code === 'admission_group_settle_failed'));
          assert.ok(!JSON.stringify(logs).includes('private@example.test'), 'no error text or PII logged');
        } finally { off(); install(); }
      });
    }

    for (const path of ['external', 'password']) {
      await t.test(`${path}: dropped chosen group never falls back to a valid invitation group`, async () => {
        await fixture(path);
        await db.setInviteProfile('inv', { userGroup: 'Keep' });
        fake?.commitReplicas();
        const write = activeDb.createUser;
        let id;
        activeDb.createUser = async user => {
          id = user.userId;
          await groups.deleteGroup('A', { db: activeDb });
          return write(user);
        };
        const hookGroups = [];
        const off = on('userCreated', async ({ userId }) => { hookGroups.push((await db.getUserById(userId, { consistentRead: true })).userGroup); });
        try {
          assert.equal((await run(path)).status, 201);
          await finalAssertions(id, null, hookGroups, path);
          assert.equal(hookGroups[0], null);
          assert.deepEqual(logger.recent().find(log => log.code === 'admission_group_dropped')?.meta, { group: 'A' });
        } finally { off(); install(); }
      });
    }
    await t.test('raw settings PUT rejects userGroups', async () => {
      await fixture('accept');
      const token = await signAccessToken('admin', 'admin');
      const raw = await request('PUT', '/v1/admin/settings', token, { userGroups: ['Injected'] });
      assert.equal(raw.status, 400);
      assert.match((await raw.json()).error, /\/v1\/admin\/groups/);
    });
    await t.test('admin PATCH validates against strong settings and accepts explicit null', async () => {
      await fixture('accept');
      const token = await signAccessToken('admin', 'admin');
      await groups.deleteGroup('A', { db: activeDb });
      const rejected = await request('PATCH', '/v1/admin/users/learner', token, { userGroup: 'A' });
      assert.equal(rejected.status, 400, 'stale settings cannot authorize a removed group');
      assert.equal((await request('PATCH', '/v1/admin/users/learner', token, { userGroup: 'Keep' })).status, 200);
      assert.equal((await db.getUserById('learner', { consistentRead: true })).userGroup, 'Keep');
      assert.equal((await request('PATCH', '/v1/admin/users/learner', token, { userGroup: null })).status, 200);
      assert.equal((await db.getUserById('learner', { consistentRead: true })).userGroup, null);
    });
    for (const path of ['admin PATCH', 'waitlist apply']) {
      await t.test(`${path}: cleanup before the assignment is settled`, async () => {
        await fixture('accept');
        if (path === 'waitlist apply') {
          await db.createWaitlistEntry({ inviteToken: 'wait', email: 'learner@example.test', profile: { userGroup: 'A' } });
          fake?.commitReplicas();
        }
        const write = activeDb.updateUser;
        activeDb.updateUser = async (id, updates) => {
          await groups.deleteGroup('A', { db: activeDb });
          return write(id, updates);
        };
        try {
          const token = await signAccessToken('admin', 'admin');
          const response = path === 'admin PATCH'
            ? await request('PATCH', '/v1/admin/users/learner', token, { userGroup: 'A' })
            : await request('POST', '/v1/admin/waitlist/wait/apply', token);
          assert.equal(response.status, 200);
          assert.equal((await db.getUserById('learner', { consistentRead: true })).userGroup, null);
          if (path === 'waitlist apply') assert.ok(!(await db.listInvites({ consistentRead: true })).some(inv => inv.inviteToken === 'wait'));
        } finally { install(); }
      });
    }
    await t.test('settlement retries CAS conflicts and preserves a valid concurrent rename and custom fields', async () => {
      await fixture('accept');
      assert.equal(typeof groups.settleGroupAssignment, 'function');
      await db.updateUser('learner', { userGroup: 'Gone', customFields: { answer: 'original' } });
      const cas = activeDb.updateUserProfileIf;
      let attempts = 0;
      activeDb.updateUserProfileIf = async (id, expected, updates) => {
        attempts++;
        await db.updateUser(id, { userGroup: 'Keep', customFields: { answer: 'newer' } });
        return cas(id, expected, updates);
      };
      try {
        const result = await groups.settleGroupAssignment('learner', { db: activeDb });
        assert.equal(result.userGroup, 'Keep');
        assert.equal(attempts, 1);
        const user = await db.getUserById('learner', { consistentRead: true });
        assert.deepEqual(user.customFields, { answer: 'newer' });
        assert.equal(user.userGroup, 'Keep');
      } finally { install(); }
    });
    await t.test('settlement bounds repeated CAS losses without overwriting a newer profile', async () => {
      await fixture('accept');
      assert.equal(typeof groups.settleGroupAssignment, 'function');
      await db.updateUser('learner', { userGroup: 'Gone' });
      const cas = activeDb.updateUserProfileIf;
      let attempts = 0;
      activeDb.updateUserProfileIf = async (id, expected, updates) => {
        await db.updateUser(id, { customFields: { version: ++attempts } });
        return cas(id, expected, updates);
      };
      try {
        await assert.rejects(groups.settleGroupAssignment('learner', { db: activeDb }), /comparison exhausted/);
        assert.equal(attempts, 3);
        assert.deepEqual((await db.getUserById('learner', { consistentRead: true })).customFields, { version: 3 });
      } finally { install(); }
    });
    await t.test('overlapping A→B and B→C cleanup cannot leave a late B assignment', async () => {
      await fixture('accept');
      await db.updateUser('learner', { userGroup: 'A' });
      fake?.commitReplicas();
      // Pause the first cleanup's membership write, after its W1 and R1.
      const original = activeDb.updateUserProfileIf;
      const late = gate(); const release = gate();
      activeDb.updateUserProfileIf = async (id, expected, updates) => {
        if (updates.userGroup === 'B') { late.resolve(); await release.promise; }
        return original(id, expected, updates);
      };
      try {
        const first = groups.renameGroup('A', 'B', { db: activeDb });
        // Original implementation used unconditional updateUser instead.
        const oldUpdate = activeDb.updateUser;
        activeDb.updateUser = async (id, updates) => {
          if (updates.userGroup === 'B') { late.resolve(); await release.promise; }
          return oldUpdate(id, updates);
        };
        await late.promise;
        await groups.renameGroup('B', 'C', { db: activeDb });
        release.resolve();
        await first;
        assert.equal((await db.getUserById('learner', { consistentRead: true })).userGroup, null, 'late B is removed because no rename history exists');
      } finally { release.resolve(); install(); }
    });
    await t.test('cleanup CAS preserves a new unrelated assignment after its scan', async () => {
      await fixture('accept');
      await db.updateUser('learner', { userGroup: 'A' });
      fake?.commitReplicas();
      const scan = activeDb.listAllUsers;
      activeDb.listAllUsers = async options => {
        const users = await scan(options);
        await db.updateUser('learner', { userGroup: 'Keep' });
        return users;
      };
      try {
        await groups.renameGroup('A', 'B', { db: activeDb });
        assert.equal((await db.getUserById('learner', { consistentRead: true })).userGroup, 'Keep');
      } finally { install(); }
    });
  });
}

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${process.env.SQLITE_PATH}${suffix}`)) unlinkSync(`${process.env.SQLITE_PATH}${suffix}`);
});
