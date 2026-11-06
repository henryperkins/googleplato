/**
 * scripts/migrate.js as an operator runs it, on SQLite. --apply must not exit
 * 0 when another run holds the migration lock: nothing ran, so the data isn't
 * migrated. "Nothing pending" is still success.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DB_PATH = join(SERVER_DIR, 'data/test-migrate-script.db');
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = DB_PATH;
const { default: db } = await import('../../src/lib/db-sqlite.js');
const { MIGRATIONS } = await import('../../src/lib/migrations.js');

const migrate = (...args) => spawnSync(process.execPath, ['scripts/migrate.js', ...args], {
  cwd: SERVER_DIR,
  env: { ...process.env, DB_BACKEND: 'sqlite', SQLITE_PATH: DB_PATH },
  encoding: 'utf8',
});

after(() => { for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) unlinkSync(f); });

describe('scripts/migrate.js', () => {
  it('--apply fails while another run holds the lock, then applies, then has nothing to do', async () => {
    await db.createSyncData('_system', 'migrations', { applied: {}, lock: { owner: 'another-run', until: Date.now() + 60_000 } });
    let run = migrate('--apply');
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /not complete: another run holds the migration lock/);
    assert.deepEqual((await db.getSyncData('_system', 'migrations')).data.applied, {}, 'nothing was applied');

    const held = await db.getSyncData('_system', 'migrations');
    await db.putSyncData('_system', 'migrations', { ...held.data, lock: null }, held.version);
    run = migrate('--apply');
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.deepEqual(Object.keys((await db.getSyncData('_system', 'migrations')).data.applied).sort(), MIGRATIONS.map((m) => m.id).sort());

    run = migrate('--apply');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Nothing to run: every migration is applied/);
  });
});
