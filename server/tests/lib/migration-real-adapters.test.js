import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresDatabase } from '../../src/lib/postgres-database.js';
import { runMigrations } from '../../src/lib/migrations.js';

process.env.SQLITE_PATH = ':memory:';
const { default: sqlite } = await import('../../src/lib/db-sqlite.js');
async function qualify(db) {
  const reads = [];
  const writes = [];
  const wrapped = Object.create(db);
  wrapped.getSyncData = async (...args) => { reads.push(args[2]); return db.getSyncData(...args); };
  wrapped.putSyncData = async (...args) => { writes.push(args[4]); return db.putSyncData(...args); };
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const migrations = [{ id: 'test', async run() { calls++; entered(); await gate; return {}; } }];
  const first = runMigrations({ db: wrapped, migrations, owner: 'first' });
  try {
    await started;
    assert.equal((await runMigrations({ db: wrapped, migrations, owner: 'second' })).skipped, 'locked');
  } finally { release(); }
  await first;
  assert.equal(calls, 1);
  assert.ok(reads.every(options => options?.consistentRead === true));
  assert.ok(writes.every(options => options?.strictVersion === true));
}
test('migration concurrency with SQLite', async () => qualify(sqlite));
test('migration concurrency with PostgreSQL', { skip: !process.env.POSTGRES_TEST_URL }, async t => {
  const schema = `migrations_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await qualify(await createPostgresDatabase(pool));
});
