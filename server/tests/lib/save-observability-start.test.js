import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

for (const entrypoint of ['start.js', 'dev.js', 'dev-sqlite.js']) {
  const production = entrypoint === 'start.js';
  test(`${entrypoint} accepts authenticated save reports over HTTP and emits structured events`, {
    skip: production && !process.env.POSTGRES_TEST_URL,
  }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'plato-save-events-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, DB_BACKEND: production ? 'postgres' : 'sqlite',
      SQLITE_PATH: join(directory, 'isolated.db'), JWT_SECRET: 'x'.repeat(48),
      APP_URL: 'https://example.test', ADMIN_EMAIL: 'operator@example.test',
      ADMIN_PASSWORD: 'startup-test-only', PORT: '0', SKIP_EMAIL: 'true' };
    if (production) {
      const schema = `save_events_${randomUUID().replaceAll('-', '')}`;
      const admin = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
      t.after(async () => {
        try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
        finally { await admin.end(); }
      });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(process.env.POSTGRES_TEST_URL);
      Object.assign(env, { INSTANCE_CONNECTION_NAME: '', PGHOST: url.hostname,
        PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1),
        PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) || 'local-test',
        PGOPTIONS: `-c search_path=${schema}` });
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { randomUUID } from 'node:crypto';
      import { Server } from 'node:net';
      import { once } from 'node:events';
      const originalListen = Server.prototype.listen;
      let listener;
      Server.prototype.listen = function (...args) { listener = this; return originalListen.apply(this, args); };
      await import('./${entrypoint}');
      if (!listener.listening) await once(listener, 'listening');
      const endpoint = 'http://127.0.0.1:' + listener.address().port + '/v1/client-events';
      const unauthenticated = await fetch(endpoint, { method: 'POST' });
      assert.equal(unauthenticated.status, 401);
      const { default: db } = await import('./src/lib/db.js');
      const { signAccessToken } = await import('./src/lib/jwt.js');
      const user = await db.getUserByEmail('operator@example.test');
      const incidentId = randomUUID();
      const events = ['client_save_unconfirmed', 'client_save_recovered'].map(code => ({
        code, eventId: randomUUID(), incidentId, operation: 'lesson_turn',
        reason: code.endsWith('recovered') ? 'confirmed' : 'network', status: 0,
      }));
      // No compatibility header: outdated tabs must still report save failures.
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: 'Bearer ' + await signAccessToken(user.userId, user.role) },
        body: JSON.stringify({ userId: user.userId, events }),
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { accepted: 2 });
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
      if (process.env.DB_BACKEND === 'postgres') await (await import('./src/lib/db-postgres.js')).closeDatabase();
    `], { cwd: new URL('../../', import.meta.url), env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const logs = `${result.stdout}\n${result.stderr}`.split('\n').filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line)).filter(log => log.code?.startsWith('client_save_'));
    assert.equal(logs.length, 2);
    assert.deepEqual(logs.map(log => log.code).sort(), ['client_save_recovered', 'client_save_unconfirmed']);
    for (const log of logs) {
      assert.equal(log.source, 'client');
      assert.match(log.actorRef, /^[0-9a-f]{64}$/);
      assert.equal(log.severity, log.code.endsWith('recovered') ? 'INFO' : 'WARNING');
    }
  });
}
