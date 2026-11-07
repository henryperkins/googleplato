import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../src/lib/migrations.js';
import { initializeLaunch } from '../../src/lib/launch.js';

const conflict = () => Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
function dbForTest() {
  let row = null;
  const reads = [];
  const writes = [];
  return {
    reads, writes,
    get row() { return row; },
    set row(value) { row = value; },
    async getSyncData(user, key, options) { reads.push(options); return structuredClone(row); },
    async createSyncData(user, key, data) { if (row) throw conflict(); row = { data: structuredClone(data), version: 1 }; },
    async putSyncData(user, key, data, version, options) {
      writes.push({ data: structuredClone(data), version, options });
      if (!row || version !== row.version) throw conflict();
      row = { data: structuredClone(data), version: row.version + 1 };
    },
  };
}
const migration = (id, run = async () => ({})) => ({ id, run });

for (const target of ['first', 'later', 'release']) test(`retries a conflict on ${target} state write`, async () => {
  const db = dbForTest();
  const original = db.putSyncData;
  let injected = false;
  db.putSyncData = async (...args) => {
    const state = args[2];
    const match = target === 'release' ? state.lock === null : target === 'first' ? !!state.applied.a && !state.applied.b : !!state.applied.b;
    if (match && !injected) { injected = true; throw conflict(); }
    return original(...args);
  };
  const outcome = await runMigrations({ db, migrations: [migration('a'), migration('b')], owner: 'self' });
  assert.equal(outcome.skipped, null);
  assert.ok(db.row.data.applied.a && db.row.data.applied.b);
  assert.equal(db.row.data.lock, null);
  assert.ok(db.reads.every(options => options?.consistentRead === true));
  assert.ok(db.writes.every(write => write.options?.strictVersion === true));
});

test('delete and recreate with a different owner stops markers and later migrations', async () => {
  const db = dbForTest();
  let later = false;
  const first = migration('a', async () => { db.row = { data: { applied: {}, lock: { owner: 'other', until: 100 } }, version: 1 }; });
  await assert.rejects(runMigrations({ db, migrations: [first, migration('b', async () => { later = true; })], owner: 'self' }), { name: 'MigrationStateError' });
  assert.equal(later, false);
  assert.equal(db.row.data.lock.owner, 'other');
  assert.deepEqual(db.row.data.applied, {});
});

test('launch rejects an unknown skip reason', async () => {
  await assert.rejects(initializeLaunch({ migrate: async () => ({ ran: [], skipped: 'unknown' }) }), /unknown/);
});

test('launch retries with the same owner', async () => {
  const owners = [];
  await initializeLaunch({ migrate: async ({ owner } = {}) => { owners.push(owner); return { ran: [], skipped: owners.length === 1 ? 'lost_race' : 'none_pending' }; } });
  assert.ok(owners[0]);
  assert.equal(owners[0], owners[1]);
});

test('persistent marker failure stops execution and preserves release failure as cause', async () => {
  const db = dbForTest();
  const original = db.putSyncData;
  let later = false;
  db.putSyncData = async (...args) => {
    if (args[2].applied.a || args[2].lock === null) throw new Error(args[2].lock === null ? 'release failed' : 'marker failed');
    return original(...args);
  };
  await assert.rejects(runMigrations({ db, owner: 'self', migrations: [migration('a'), migration('b', async () => { later = true; })] }), err => {
    assert.equal(err.name, 'MigrationStateError');
    assert.match(err.cause.message, /release failed/);
    return true;
  });
  assert.equal(later, false);
});

test('release failure after verified markers returns a stale-lock diagnostic', async () => {
  const db = dbForTest();
  const original = db.putSyncData;
  db.putSyncData = async (...args) => {
    if (args[2].lock === null) throw new Error('release failed');
    return original(...args);
  };
  const outcome = await runMigrations({ db, owner: 'self', migrations: [migration('a')] });
  assert.equal(outcome.skipped, null);
  assert.equal(outcome.staleLock.owner, 'self');
  assert.equal(outcome.staleLock.lock.owner, 'self');
  assert.equal(outcome.staleLock.version, db.row.version);
});

test('an unverified marker stops the next migration and raises MigrationStateError', async () => {
  const db = dbForTest();
  const original = db.putSyncData;
  let later = false;
  db.putSyncData = async (...args) => {
    await original(...args);
    if (args[2].applied.a && args[2].lock) delete db.row.data.applied.a;
  };
  await assert.rejects(runMigrations({ db, owner: 'self', migrations: [migration('a'), migration('b', async () => { later = true; })] }), { name: 'MigrationStateError' });
  assert.equal(later, false);
  assert.equal(db.row.data.lock, null);
});

test('launch keeps the same owner across initialization attempts in one process', async () => {
  const owners = [];
  const migrate = async ({ owner } = {}) => { owners.push(owner); return { ran: [], skipped: 'none_pending' }; };
  await initializeLaunch({ migrate });
  await initializeLaunch({ migrate });
  assert.ok(owners[0]);
  assert.equal(owners[0], owners[1]);
});

test('release read failure reports the last verified lock details', async () => {
  const db = dbForTest();
  const get = db.getSyncData;
  let reads = 0;
  db.getSyncData = async (...args) => { if (++reads === 4) throw new Error('release read failed'); return get(...args); };
  const result = await runMigrations({ db, owner: 'self', migrations: [migration('a')] });
  assert.equal(result.staleLock.lock.owner, 'self');
  assert.equal(result.staleLock.version, 2);
  assert.ok(result.staleLock.until);
});
