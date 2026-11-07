import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATIONS } from '../../src/lib/migrations.js';

const migration = MIGRATIONS.find(m => m.id === 'm004_default_program');
const conflict = () => Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
function database(entries) {
  const rows = new Map(Object.entries(entries).map(([key, data]) => [key, { data: structuredClone(data), version: 1 }]));
  return {
    rows,
    async getAllSyncData() { return [...rows].map(([dataKey, row]) => ({ dataKey, ...structuredClone(row) })); },
    async createSyncData(owner, key, data) { if (rows.has(key)) throw conflict(); rows.set(key, { data: structuredClone(data), version: 1 }); },
    async putSyncData(owner, key, data, version, options) {
      const row = rows.get(key);
      if (options?.strictVersion ? !row || row.version !== version : row && row.version !== version) throw conflict();
      rows.set(key, { data: structuredClone(data), version: (row?.version || 0) + 1 });
    },
  };
}
const run = db => migration.run({ db, dryRun: false });

test('m004 rerun leaves an explicitly unassigned unit after its course was deleted', async () => {
  const db = database({ 'course:u': { name: 'Unit', programId: null, lessonIds: ['l'] } });
  await run(db);
  assert.equal(db.rows.has('program:prog-default'), false);
  assert.equal(db.rows.get('course:u').data.programId, null);
});

test('m004 appends a new unit to an existing default course without changing order', async () => {
  const db = database({ 'program:prog-default': { name: 'Custom', unitIds: ['b', 'a'] }, 'course:a': { name: 'A', programId: 'prog-default' }, 'course:b': { name: 'B', programId: 'prog-default' }, 'course:c': { name: 'C' } });
  await run(db);
  assert.deepEqual(db.rows.get('program:prog-default').data.unitIds, ['b', 'a', 'c']);
  assert.equal(db.rows.get('course:c').data.programId, 'prog-default');
});

test('m004 does not resurrect a unit deleted while migration runs', async () => {
  const db = database({ 'course:u': { name: 'Unit' } });
  const put = db.putSyncData;
  db.putSyncData = async (...args) => { if (args[1] === 'course:u') db.rows.delete('course:u'); return put(...args); };
  const result = await run(db);
  assert.equal(result.errors, 1);
  assert.equal(db.rows.has('course:u'), false);
});

for (const id of ['custom', 'getting-started']) test(`m004 preserves a listed ${id} unit renamed by RC-232`, async () => {
  const db = database({ 'program:prog-default': { unitIds: [id, 'other'] }, [`course:${id}`]: { name: 'Renamed', lessonIds: ['z', 'a'] }, 'course:other': { programId: 'prog-default' } });
  const before = structuredClone([...db.rows]);
  await run(db);
  assert.deepEqual([...db.rows], before);
});
