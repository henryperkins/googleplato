/** Durable unit order through rollbacks and concurrent membership changes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { Hono } from 'hono';
process.env.DB_BACKEND = 'sqlite';
const scratch = mkdtempSync(join(tmpdir(), 'plato-unit-order-'));
process.env.SQLITE_PATH = join(scratch, 'test.db');
after(() => rmSync(scratch, { recursive: true, force: true }));
const { default: shared } = await import('../../src/lib/db.js');
const { registerHierarchyRoutes } = await import('../../src/routes/admin-hierarchy.js');
const { buildHierarchy } = await import('../../src/lib/hierarchy.js');
const { repairUnits } = await import('../../src/lib/unit-repair.js');
const { createPostgresDatabase } = await import('../../src/lib/postgres-database.js');
const { default: dynamo, setDocumentClientForTests } = await import('../../src/lib/db-dynamodb.js');
const { StaleDocumentClient } = await import('../helpers/stale-document-client.js');

const { reconcileUnitOrders } = await import('../../src/lib/unit-order.js');
const { MIGRATIONS } = await import('../../src/lib/migrations.js');
const conditional = { name: 'ConditionalCheckFailedException' };
function gate() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

for (const backend of ['sqlite', 'postgres', 'dynamodb']) {
  test(`unit order: ${backend}`, { skip: backend === 'postgres' && !process.env.POSTGRES_TEST_URL }, async t => {
    let db = shared;
    let pool;
    let admin;
    let schema;
    let fake;
    if (backend === 'postgres') {
      schema = `unit_order_${randomUUID().replaceAll('-', '')}`;
      admin = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL, options: `-c search_path=${schema}` });
      db = await createPostgresDatabase(pool);
    } else if (backend === 'dynamodb') {
      fake = new StaleDocumentClient();
      setDocumentClientForTests(fake);
      db = dynamo;
    }
    const original = { ...shared };
    if (db !== shared) Object.assign(shared, db);
    t.after(async () => {
      Object.assign(shared, original);
      if (pool) { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
    });
    const app = new Hono();
    app.onError(error => {
      if (error.message.includes('injected order failure')) return new Response('Injected test failure', { status: 500 });
      throw error;
    });
    app.use('*', async (c, next) => { c.set('user', { userId: 'admin', username: 'Admin' }); await next(); });
    registerHierarchyRoutes(app);
    const api = async (method, path, body, status = 200) => {
      const res = await app.request(`/v1/admin/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      assert.equal(res.status, status, await res.clone().text());
      if (fake) for (const row of fake.rows.values()) row.previous = structuredClone(row.current);
      return res;
    };
    const read = key => shared.getSyncData('_system', key, { consistentRead: true });
    const write = async (key, data) => {
      const cur = await read(key);
      if (cur) await shared.putSyncData('_system', key, data, cur.version, { strictVersion: true });
      else await shared.createSyncData('_system', key, data);
    };
    const hierarchy = async () => buildHierarchy(await shared.getAllSyncData('_system', { consistentRead: true }));
    const order = async () => (await hierarchy()).units.get('u1').lessonIds;
    const reorder = () => api('PUT', 'units/u1/order', { lessonIds: ['l3', 'l1', 'l2'] });
    const renameOld = async () => {
      const unit = await read('course:u1');
      await write('course:u1', { name: 'RC-232 rename', createdAt: unit.data.createdAt });
      if (fake) for (const row of fake.rows.values()) row.previous = structuredClone(row.current);
      await repairUnits({ db: shared });
    };
    async function reset() {
      for (const item of await shared.getAllSyncData('_system', { consistentRead: true })) await shared.deleteSyncData('_system', item.dataKey);
      await write('program:p1', { name: 'One', unitIds: ['u1'] });
      await write('program:p2', { name: 'Two', unitIds: [] });
      await write('course:u1', { name: 'Unit', programId: 'p1', createdAt: '2026-01-01' });
      for (const id of ['l1', 'l2', 'l3']) await write(`lesson:${id}`, { name: id, course: 'u1' });
      if (fake) for (const row of fake.rows.values()) row.previous = structuredClone(row.current);
    }
    await t.test('review reproduction: unassign, reorder, RC-232 rename and restart preserves exact order', async () => {
      await reset();
      await api('PUT', 'units/u1', { name: 'Unit', programId: null });
      await reorder();
      await renameOld();
      assert.deepEqual(await order(), ['l3', 'l1', 'l2']);
    });
    await t.test('review reproduction: reorder racing move between courses preserves exact order', async () => {
      await reset();
      const entered = gate(); const release = gate();
      const getAll = shared.getAllSyncData;
      let pause = true;
      shared.getAllSyncData = async (...args) => {
        const snapshot = await getAll(...args);
        if (pause) { pause = false; entered.resolve(); await release.promise; }
        return snapshot;
      };
      try {
        const pending = reorder();
        await entered.promise;
        await api('PUT', 'units/u1', { name: 'Unit', programId: 'p2' });
        release.resolve();
        await pending;
      } finally { release.resolve(); shared.getAllSyncData = getAll; }
      await renameOld();
      assert.deepEqual(await order(), ['l3', 'l1', 'l2']);
    });
    for (const change of ['join', 'leave']) await t.test(`${change} during reorder preserves membership without hiding or duplicating lessons`, async () => {
      await reset();
      const entered = gate(); const release = gate();
      const getAll = shared.getAllSyncData;
      let pause = true;
      shared.getAllSyncData = async (...args) => {
        const snapshot = await getAll(...args);
        if (pause) { pause = false; entered.resolve(); await release.promise; }
        return snapshot;
      };
      try {
        const pending = reorder();
        await entered.promise;
        if (change === 'join') {
          await write('lesson:join-z', { name: 'Zebra', course: 'u1' });
          await write('lesson:join-a', { name: 'Alpha', course: 'u1' });
        } else await write('lesson:l1', { name: 'l1', course: null });
        release.resolve(); await pending;
      } finally { release.resolve(); shared.getAllSyncData = getAll; }
      const expected = change === 'join' ? ['l3', 'l1', 'l2', 'join-a', 'join-z'] : ['l3', 'l2'];
      assert.deepEqual(await order(), expected);
      assert.equal(new Set(await order()).size, expected.length);
    });
    await t.test('write failure leaves unit and order byte-identical', async () => {
      await reset(); await reorder();
      const before = [await read('course:u1'), await read('unitOrder:u1')];
      let restore;
      let failedWrites = 0;
      if (backend === 'sqlite') {
        const connection = new Database(process.env.SQLITE_PATH);
        connection.exec("CREATE TRIGGER fail_order BEFORE UPDATE ON sync_data WHEN NEW.dataKey = 'unitOrder:u1' BEGIN SELECT RAISE(ABORT, 'injected order failure'); END");
        restore = async () => { connection.exec('DROP TRIGGER fail_order'); connection.close(); };
      } else if (backend === 'postgres') {
        await pool.query(`CREATE FUNCTION fail_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data_key = 'unitOrder:u1' THEN RAISE EXCEPTION 'injected order failure'; END IF; RETURN NEW; END $$`);
        await pool.query('CREATE TRIGGER fail_order BEFORE UPDATE ON sync_data FOR EACH ROW EXECUTE FUNCTION fail_order()');
        restore = async () => { await pool.query('DROP TRIGGER fail_order ON sync_data'); await pool.query('DROP FUNCTION fail_order()'); };
      } else {
        const send = fake.send.bind(fake);
        fake.send = async command => {
          if (command.constructor.name === 'PutCommand' && command.input.Item.dataKey === 'unitOrder:u1') {
            failedWrites++;
            throw Object.assign(new Error('injected condition failure'), conditional);
          }
          return send(command);
        };
        restore = async () => { fake.send = send; };
      }
      try { await api('PUT', 'units/u1/order', { lessonIds: ['l2', 'l1', 'l3'] }, backend === 'dynamodb' ? 409 : 500); }
      finally { await restore(); }
      if (fake) assert.equal(failedWrites, 3, 'version conflicts have a bounded retry count');
      assert.deepEqual([await read('course:u1'), await read('unitOrder:u1')], before);
    });
    await t.test('old release delete and ID recreation ignores old incarnation order', async () => {
      await reset(); await reorder();
      await shared.deleteSyncData('_system', 'course:u1');
      await write('course:u1', { name: 'New incarnation', createdAt: '2026-02-01' });
      assert.deepEqual(await order(), ['l1', 'l2', 'l3']);
      assert.deepEqual(await reconcileUnitOrders({ db: shared }), { removed: ['u1'], conflicted: [] });
      assert.equal(await read('unitOrder:u1'), null);
    });
    await t.test('conditional deletion refuses a newer record and a missing record', async () => {
      await reset(); await reorder();
      const old = await read('unitOrder:u1');
      await write('unitOrder:u1', { ...old.data, lessonIds: ['l2', 'l1', 'l3'] });
      await assert.rejects(shared.deleteSyncData('_system', 'unitOrder:u1', { expectedVersion: old.version }), conditional);
      assert.deepEqual((await read('unitOrder:u1')).data.lessonIds, ['l2', 'l1', 'l3']);
      await shared.deleteSyncData('_system', 'unitOrder:u1', { expectedVersion: old.version + 1 });
      await assert.rejects(shared.deleteSyncData('_system', 'unitOrder:u1', { expectedVersion: old.version + 1 }), conditional);
    });
    await t.test('orphan cleanup cannot erase an order repaired after its read', async () => {
      await reset(); await reorder();
      await write('course:u1', { name: 'New incarnation', createdAt: '2026-02-01' });
      const remove = shared.deleteSyncData;
      shared.deleteSyncData = async (...args) => {
        await write('unitOrder:u1', { lessonIds: ['l2', 'l1', 'l3'], unitCreatedAt: '2026-02-01' });
        return remove(...args);
      };
      try { assert.deepEqual(await reconcileUnitOrders({ db: shared }), { removed: [], conflicted: ['u1'] }); }
      finally { shared.deleteSyncData = remove; }
      assert.deepEqual(await order(), ['l2', 'l1', 'l3']);
    });
    await t.test('retries an order version race and validates current members', async () => {
      await reset(); await reorder();
      const put = shared.putSyncData;
      let raced = false;
      shared.putSyncData = async (u, k, ...args) => {
        if (k === 'unitOrder:u1' && !raced) {
          raced = true;
          const current = await read(k);
          await put(u, k, { ...current.data, lessonIds: ['l1', 'l2', 'l3'] }, current.version, { strictVersion: true });
        }
        return put(u, k, ...args);
      };
      try { await reorder(); } finally { shared.putSyncData = put; }
      assert.equal(raced, true);
      assert.deepEqual(await order(), ['l3', 'l1', 'l2']);
      await api('PUT', 'units/u1/order', { lessonIds: ['l1', 'l1', 'l3'] }, 400);
      if (fake) {
        assert.ok(fake.commands.some(c => c.constructor.name === 'GetCommand' && c.input.Key.dataKey === 'unitOrder:u1' && c.input.ConsistentRead));
        assert.ok(fake.commands.some(c => c.constructor.name === 'QueryCommand' && c.input.ConsistentRead));
      }
    });
    await t.test('incarnation mismatch uses legacy order and a matching stamp overrides it', async () => {
      await reset();
      await write('course:u1', { name: 'Legacy', createdAt: 'new', lessonIds: ['l2', 'l3', 'l1'] });
      await write('unitOrder:u1', { lessonIds: ['l3', 'l1', 'l2'], unitCreatedAt: 'old' });
      assert.deepEqual(await order(), ['l2', 'l3', 'l1']);
      await write('unitOrder:u1', { lessonIds: ['l3', 'l1', 'l2'], unitCreatedAt: 'new' });
      assert.deepEqual(await order(), ['l3', 'l1', 'l2']);
    });
    if (fake) await t.test('strong reorder snapshot works while the replica has none of the current records', async () => {
      await reset(); await reorder();
      for (const row of fake.rows.values()) row.previous = undefined;
      await reorder();
      assert.deepEqual(await order(), ['l3', 'l1', 'l2']);
    });
    await t.test('m006 only creates missing stamped legacy orders and preserves existing records', async () => {
      await reset();
      await write('course:u1', { name: 'Legacy', createdAt: 'legacy-stamp', lessonIds: ['l2', 'l3', 'l1'] });
      const migration = MIGRATIONS.find(m => m.id === 'm006_unit_order');
      await migration.run({ db: shared, dryRun: true });
      assert.equal(await read('unitOrder:u1'), null);
      assert.equal((await migration.run({ db: shared, dryRun: false })).updated, 1);
      assert.deepEqual((await read('unitOrder:u1')).data, { lessonIds: ['l2', 'l3', 'l1'], unitCreatedAt: 'legacy-stamp' });
      const before = await read('unitOrder:u1');
      assert.equal((await migration.run({ db: shared, dryRun: false })).updated, 0);
      assert.deepEqual(await read('unitOrder:u1'), before);
    });
    for (const stamp of ['2026-01-01', 'stale']) await t.test(`new-code unit deletion removes its ${stamp} order`, async () => {
      await reset(); await reorder();
      await write('unitOrder:u1', { lessonIds: ['l3', 'l1', 'l2'], unitCreatedAt: stamp });
      await api('DELETE', 'units/u1');
      assert.equal(await read('unitOrder:u1'), null);
    });
  });
}
