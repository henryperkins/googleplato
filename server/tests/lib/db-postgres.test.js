import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { createPostgresDatabase } from '../../src/lib/postgres-database.js';
import { comparePassword } from '../../src/lib/password.js';

// Uses a real PostgreSQL server and a disposable schema, never application tables.
// POSTGRES_TEST_URL=postgres://postgres@127.0.0.1:55432/postgres npm run test:server
test('PostgreSQL persistence and concurrent writers', { skip: !process.env.POSTGRES_TEST_URL }, async t => {
  const schema = `plato_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { connectionString: process.env.POSTGRES_TEST_URL, options: `-c search_path=${schema}`, max: 5 };
  let pool = new pg.Pool(options);
  const otherPool = new pg.Pool(options);
  t.after(async () => {
    await Promise.all([pool.end(), otherPool.end()]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  let db = await createPostgresDatabase(pool);
  const other = await createPostgresDatabase(otherPool);
  const conditional = { name: 'ConditionalCheckFailedException' };
  const url = new URL(process.env.POSTGRES_TEST_URL);
  const runProduction = (source, env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, DB_BACKEND: 'postgres', INSTANCE_CONNECTION_NAME: '',
      PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1),
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) || 'local-test',
      PGOPTIONS: `-c search_path=${schema}`, JWT_SECRET: 'x'.repeat(48), APP_URL: 'https://example.test',
      ADMIN_EMAIL: 'operator@example.test', PORT: '0', ...env },
    encoding: 'utf8', timeout: 15000,
  });

  await t.test('account, invite, token and audit contracts', async () => {
    await db.createUser({ userId: 'u', email: 'Learner@Example.test', username: 'Learner', passwordHash: 'hash', name: 'Learner', role: 'user', customFields: { a: 1, b: 2 } });
    await assert.rejects(other.createUser({ userId: 'duplicate', email: 'learner@example.test', passwordHash: 'hash', role: 'user' }), conditional);
    assert.equal((await db.getUserByEmail('LEARNER@EXAMPLE.TEST')).userId, 'u');
    assert.equal((await db.getUserByUsername('LEARNER')).userId, 'u');
    await db.updateUser('u', { name: 'Updated' });
    const updatedAt = (await db.getUserById('u')).updatedAt;
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? db : other).incrementUserCounter('u', 'lessonsCompleted')));
    await db.setUserActivityField('u', 'lastActiveAt', '2026-10-20T00:00:00.000Z');
    await db.removeUserCustomField('u', 'a');
    const user = await db.getUserById('u');
    assert.equal(user.lessonsCompleted, 10);
    assert.equal(user.updatedAt, updatedAt);
    assert.deepEqual(user.customFields, { b: 2 });
    assert.equal(await db.countUsers(), 1);
    assert.equal((await db.listUsers()).length, 1);
    assert.equal((await db.listAllUsers()).length, 1);
    await assert.rejects(db.incrementUserCounter('u', 'role'), /Unsupported/);
    await assert.rejects(db.setUserActivityField('u', 'role', 'admin'), /Unsupported/);

    await db.createInvite({ inviteToken: 'link', isLink: true, maxUsages: 1 });
    const uses = await Promise.allSettled([db.incrementLinkUsage('link'), other.incrementLinkUsage('link')]);
    assert.equal(uses.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await db.getInviteLinkToken()).usageCount, 1);
    await db.markInviteUsed('link');
    assert.equal(await db.getInviteLinkToken(), null);
    await db.createInvite({ inviteToken: 'email', email: 'Invite@Example.test', profile: { name: 'Invite' } });
    assert.deepEqual((await db.getInviteByEmail('INVITE@EXAMPLE.TEST')).profile, { name: 'Invite' });
    await db.createWaitlistEntry({ inviteToken: 'wait', email: 'Wait@Example.test', profile: { name: 'Wait' } });
    await db.updateWaitlistEntry('wait', { email: 'new@example.test', profile: { name: 'New' } });
    assert.equal((await db.getWaitlistEntryByEmail('new@example.test')).inviteToken, 'wait');
    await assert.rejects(db.updateWaitlistEntry('email', { email: 'new@example.test', profile: {} }), conditional);
    await db.setInviteProfile('wait', { name: 'Edited' });
    assert.deepEqual((await db.getInvite('wait')).profile, { name: 'Edited' });
    assert.equal((await db.listInvites()).length, 3);
    await db.deleteInvite('email');
    assert.equal(await db.getInvite('email'), null);

    await db.storeRefreshToken('refresh', 'u');
    await db.storeResetToken('reset', 'u');
    assert.equal((await db.getRefreshToken('refresh')).userId, 'u');
    assert.equal(await db.getRefreshToken('reset'), null);
    assert.equal(await db.getResetToken('refresh'), null);
    assert.equal((await db.getResetToken('reset')).userId, 'u');
    await db.deleteResetToken('reset');
    await db.deleteRefreshToken('refresh');
    assert.equal(await db.getRefreshToken('refresh'), null);
    await db.createAuditLog({ action: 'test', userId: 'u', details: { safe: true } });
    assert.deepEqual((await db.listAuditLogsForUser('u'))[0].details, { safe: true });
    assert.equal((await db.listAuditLogsForUser('u', '2099-01-01')).length, 0);
  });

  await t.test('token consume is atomic across instances and revocation works (SEC-2, SEC-3)', async () => {
    await db.storeRefreshToken('versioned-refresh', 'u', 'credential-version');
    assert.equal((await other.consumeRefreshToken('versioned-refresh')).credentialVersion, 'credential-version');
    await db.storeRefreshToken('race-refresh', 'u');
    const consumed = await Promise.all([db.consumeRefreshToken('race-refresh'), other.consumeRefreshToken('race-refresh')]);
    assert.equal(consumed.filter(Boolean).length, 1);
    assert.equal(await db.consumeRefreshToken('race-refresh'), null);

    await db.storeResetToken('race-reset', 'u');
    assert.equal(await db.consumeRefreshToken('race-reset'), null);
    assert.equal((await db.consumeResetToken('race-reset')).userId, 'u');
    assert.equal(await db.consumeResetToken('race-reset'), null);

    await pool.query(`INSERT INTO refresh_tokens (id, document) VALUES ('expired-refresh', $1::jsonb)`,
      [JSON.stringify({ tokenHash: 'expired-refresh', userId: 'u', type: 'refresh', createdAt: new Date().toISOString(), ttl: 1 })]);
    assert.equal(await db.getRefreshToken('expired-refresh'), null);
    assert.equal(await db.consumeRefreshToken('expired-refresh'), null);

    await db.storeRefreshToken('revoke-a', 'u');
    await db.storeResetToken('revoke-b', 'u');
    await db.storeRefreshToken('revoke-keep', 'someone-else');
    await db.revokeUserTokens('u');
    assert.equal(await db.getRefreshToken('revoke-a'), null);
    assert.equal(await db.getResetToken('revoke-b'), null);
    assert.equal((await db.getRefreshToken('revoke-keep')).userId, 'someone-else');
  });

  await t.test('strict creation, updates and literal prefix filtering', async () => {
    const results = await Promise.allSettled([db, other].map(d => d.putSyncData('u', 'lessonKB:strict', {}, 0, { strictVersion: true })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    await assert.rejects(db.putSyncData('u', 'lessonKB:strict', {}, 0, { strictVersion: true }), conditional);
    await assert.rejects(db.putSyncData('u', 'missing', {}, 1, { strictVersion: true }), conditional);
    await db.putSyncData('u', 'lessonKB:strict', { ok: true }, 1, { strictVersion: true });
    await assert.rejects(other.putSyncData('u', 'lessonKB:strict', {}, 1), conditional);
    await db.putSyncData('u', 'literal_%:a', [], 0);
    await db.putSyncData('u', 'literal_other:a', [], 0);
    assert.equal((await db.getSyncDataByPrefix('u', 'literal_%:')).length, 1);
    assert.equal((await db.getAllSyncData('u')).length, 3);
  });

  await t.test('two instances cannot commit divergent turns from the same base', async () => {
    const base = await db.getLessonState('u', 'race');
    const turns = [1, 2].map(id => ({ messages: [{ id: `m${id}`, role: 'assistant', content: `Reply ${id}` }], lessonKB: { score: id } }));
    const results = await Promise.allSettled([db.commitLessonTurn('u', 'race', base, turns[0]), other.commitLessonTurn('u', 'race', base, turns[1])]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const winner = results.findIndex(r => r.status === 'fulfilled');
    const state = await other.getLessonState('u', 'race');
    assert.deepEqual(state.messages, { data: turns[winner].messages, version: 1 });
    assert.deepEqual(state.lessonKB, { data: turns[winner].lessonKB, version: 1 });
  });

  await t.test('failed second write rolls the transcript back', async () => {
    await pool.query(`ALTER TABLE sync_data ADD CONSTRAINT reject_test_kb CHECK (data_key <> 'lessonKB:rollback')`);
    const base = await db.getLessonState('u', 'rollback');
    await assert.rejects(db.commitLessonTurn('u', 'rollback', base, { messages: [{ id: 'no-partial-save' }], lessonKB: {} }), { code: '23514' });
    assert.deepEqual(await other.getLessonState('u', 'rollback'), base);
    await pool.query('ALTER TABLE sync_data DROP CONSTRAINT reject_test_kb');
  });

  await t.test('resets invalidate old turns even when content and versions return to empty', async () => {
    const base = await db.getLessonState('u', 'reset');
    await other.deleteSyncData('u', 'messages:reset', { invalidateLesson: true });
    await assert.rejects(db.commitLessonTurn('u', 'reset', base, { messages: [{ id: 'stale' }], lessonKB: {} }), conditional);
    const current = await db.getLessonState('u', 'reset');
    assert.notEqual(current.generation, base.generation);
    assert.deepEqual(current.messages.data, []);
    await other.deleteSyncData('u', 'lessonKB:reset', { invalidateLesson: true });
    const restarted = await db.getLessonState('u', 'reset');
    assert.notEqual(restarted.generation, current.generation);
    await assert.rejects(db.commitLessonTurn('u', 'reset', current, { messages: [{ id: 'also-stale' }], lessonKB: {} }), conditional);
  });

  await t.test('same-version content changes cannot be overwritten', async () => {
    await db.putSyncData('u', 'messages:changed', [{ id: 'old' }], 0);
    const base = await db.getLessonState('u', 'changed');
    await other.putSyncData('u', 'messages:changed', [{ id: 'admin-edit' }], 0);
    await assert.rejects(db.commitLessonTurn('u', 'changed', base, { messages: [{ id: 'old' }, { id: 'stale' }], lessonKB: {} }), conditional);
    assert.deepEqual((await db.getLessonState('u', 'changed')).messages.data, [{ id: 'admin-edit' }]);
  });

  await t.test('saved turns survive replacement of all application connections', async () => {
    const before = await db.getLessonState('u', 'race');
    await pool.end();
    pool = new pg.Pool(options);
    db = await createPostgresDatabase(pool);
    assert.deepEqual(await db.getLessonState('u', 'race'), before);
    assert.equal((await db.getUserById('u')).name, 'Updated');
    await db.deleteUser('u');
    assert.equal(await db.getUserById('u'), null);
  });

  await t.test('production bootstrap keeps its password out of runtime configuration on every start', async () => {
    const start = password => runProduction(`
      import assert from 'node:assert/strict';
      import { Server } from 'node:net';
      import { once } from 'node:events';
      const originalListen = Server.prototype.listen;
      let listener;
      Server.prototype.listen = function (...args) { listener = this; return originalListen.apply(this, args); };
      await import('./start.js');
      if (!listener.listening) await once(listener, 'listening');
      const preflight = await fetch('http://127.0.0.1:' + listener.address().port + '/v1/sync/profile', {
        method: 'OPTIONS', headers: { Origin: 'https://example.test',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'X-Plato-Client-Protocol,X-Plato-Client-Epoch,Content-Type,Authorization' },
      });
      assert.equal(preflight.status, 204);
      const allowed = preflight.headers.get('access-control-allow-headers').toLowerCase();
      assert.ok(allowed.includes('x-plato-client-protocol'));
      assert.ok(allowed.includes('x-plato-client-epoch'));
      const config = await import('./src/config.js');
      console.log(JSON.stringify({ event: 'bootstrap_credentials',
        environmentRetainsPassword: !!process.env.ADMIN_PASSWORD,
        configRetainsPassword: !!config.ADMIN_PASSWORD }));
      setImmediate(() => process.kill(process.pid, 'SIGTERM'));
    `, { ADMIN_PASSWORD: password });
    for (const password of ['initial-test-password', 'must-not-reset-password']) {
      const result = start(password);
      assert.equal(result.status, 0, result.stderr);
      const credentials = result.stdout.split('\n').filter(line => line.startsWith('{'))
        .map(line => JSON.parse(line)).find(item => item.event === 'bootstrap_credentials');
      assert.deepEqual(credentials, { event: 'bootstrap_credentials', environmentRetainsPassword: false, configRetainsPassword: false });
      const operator = await db.getUserByEmail('operator@example.test');
      assert.equal(operator.role, 'admin');
      assert.equal(await comparePassword('initial-test-password', operator.passwordHash), true);
      assert.equal(await db.countUsers(), 1);
    }
  });

  await t.test('concurrent startup seeders recover conflicts without hiding persistent failures', () => {
    const result = runProduction(`
      import assert from 'node:assert/strict';
      import db from './src/lib/db.js';
      import { closeDatabase } from './src/lib/db-postgres.js';
      import { seedDefaultContent } from './src/lib/seed.js';
      try {
        const prompt = (await db.getSyncDataByPrefix('_system', 'prompt:'))[0];
        await db.putSyncData('_system', prompt.dataKey, { content: 'previous release' }, prompt.version);
        const read = db.getSyncData;
        let arrivals = 0;
        let release;
        const barrier = new Promise(resolve => { release = resolve; });
        db.getSyncData = async (userId, key) => {
          const row = await read(userId, key);
          if (key === prompt.dataKey && arrivals < 2) {
            if (++arrivals === 2) release();
            await barrier;
          }
          return row;
        };
        const results = await Promise.allSettled([seedDefaultContent(), seedDefaultContent()]);
        assert.deepEqual(results.map(item => item.status), ['fulfilled', 'fulfilled']);
        assert.deepEqual((await read('_system', prompt.dataKey)).data, prompt.data);
        db.getSyncData = read;

        const current = await read('_system', prompt.dataKey);
        await db.putSyncData('_system', prompt.dataKey, { content: 'previous release' }, current.version);
        for (const failure of [Object.assign(new Error('denied'), { code: '42501' }),
          Object.assign(new Error('still racing'), { name: 'ConditionalCheckFailedException' })]) {
          let writes = 0;
          db.putSyncData = async () => { writes++; throw failure; };
          await assert.rejects(seedDefaultContent(), error => error === failure);
          if (failure.code) assert.equal(writes, 1);
          else assert.equal(writes, 3);
        }
      } finally {
        await closeDatabase();
      }
    `);
    assert.equal(result.status, 0, result.stderr);
  });
});
