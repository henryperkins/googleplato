import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

test('production HTTP assembly migrates and enforces unsubscribe, view-as, and awaited jobs', { skip: !process.env.POSTGRES_TEST_URL }, async t => {
  const schema = `http_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await pool.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
  const url = new URL(process.env.POSTGRES_TEST_URL);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { app } = await import('./start.js');
    const db = (await import('./src/lib/db.js')).default;
    const { unsubscribeToken } = await import('./src/lib/notifications.js');
    const { registerJob, dispatchJob } = await import('./src/lib/jobs.js');
    const { signAccessToken } = await import('./src/lib/jwt.js');
    const migrations = await db.getSyncData('_system', 'migrations');
    const { MIGRATIONS } = await import('./src/lib/migrations.js');
    assert.deepEqual(Object.keys(migrations.data.applied).sort(), MIGRATIONS.map(m => m.id).sort());
    const user = await db.getUserByEmail('operator@example.test');
    const token = await signAccessToken(user.userId, 'admin');
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Plato-View-As': 'usr_target' };
    const denied = await app.request('/v1/me', { method: 'PATCH', headers, body: JSON.stringify({ firstName: 'Should not save' }) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'view_as_read_only');
    await db.createUser({ userId: 'usr_teacher', email: 'teacher@example.test', passwordHash: 'hash', name: 'Mary Ann Evans', firstName: 'Mary Ann', lastName: 'Evans', nameSource: 'user', role: 'educator' });
    const teacherToken = await signAccessToken('usr_teacher', 'educator');
    const teacherHeaders = { Authorization: 'Bearer ' + teacherToken, 'Content-Type': 'application/json' };
    const call = (method, path, body) => app.request(path, { method, headers: teacherHeaders, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await call('GET', '/v1/admin/users')).status, 200);
    assert.equal((await call('GET', '/v1/admin/ai-settings')).status, 403);
    const self = await (await call('GET', '/v1/me')).json();
    assert.equal(self.firstName, 'Mary Ann');
    assert.equal((await call('PUT', '/v1/admin/lessons/..%2FAGENTS', { name: 'Unsafe', status: 'draft' })).status, 400);
    assert.equal((await call('PUT', '/v1/admin/programs/prog-test', { name: 'Course' })).status, 200);
    assert.equal((await call('PUT', '/v1/admin/units/unit-test', { name: 'Unit', programId: 'prog-test' })).status, 200);
    await db.createSyncData('_system', 'lesson:test-placement', { name: 'Placed', status: 'public', course: 'unit-test' });
    const lesson = await (await call('GET', '/v1/lessons/test-placement')).json();
    assert.equal(lesson.program.id, 'prog-test');
    assert.equal(lesson.unit.id, 'unit-test');
    await db.createInvite({ inviteToken: 'inv_existing', email: 'teacher@example.test', forUserId: 'usr_teacher', profile: {} });
    assert.equal((await (await call('GET', '/v1/me/invite')).json()).invite.inviteToken, 'inv_existing');
    assert.equal((await call('POST', '/v1/me/invite/inv_existing/accept', {})).status, 200);
    assert.equal((await db.getInvite('inv_existing')).status, 'used');
    const unsubscribe = await app.request('/v1/unsubscribe?token=' + unsubscribeToken(user.userId, 'messages'), { method: 'POST' });
    assert.equal(unsubscribe.status, 200);
    assert.equal((await db.getSyncData(user.userId, 'notify:state')).data.optOut.messages, true);
    let completed = false;
    registerJob('http-test', async () => { await new Promise(resolve => setImmediate(resolve)); completed = true; });
    await dispatchJob('http-test');
    assert.equal(completed, true, 'HTTP dispatch must finish before response-owned work resolves');
    assert.equal(process.env.ADMIN_PASSWORD, undefined);
    process.kill(process.pid, 'SIGTERM');
  `], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DB_BACKEND: 'postgres', INSTANCE_CONNECTION_NAME: '', PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: url.pathname.slice(1), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGOPTIONS: `-c search_path=${schema}`, JWT_SECRET: 'local-test-'.repeat(5), APP_URL: 'https://example.test', ADMIN_EMAIL: 'operator@example.test', ADMIN_PASSWORD: 'local-test-password', PORT: '0', SKIP_EMAIL: 'true' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
