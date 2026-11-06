/**
 * Units an older release rewrote (src/lib/unit-repair.js). Setup goes through
 * the real hierarchy routes on SQLite, so the course record's `lessonOrder`
 * copy is written exactly as in production. `oldReleaseRename` writes what
 * Beta-RC-232's PUT /v1/admin/courses/:courseId (and this fork's routes before
 * the launch integration) writes: a replacement record with only the name and
 * the created/updated stamps.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { Hono } = await import('hono');
const { default: db } = await import('../../src/lib/db.js');
const { default: admin } = await import('../../src/routes/admin.js');
const { signAccessToken } = await import('../../src/lib/jwt.js');
const { buildHierarchy } = await import('../../src/lib/hierarchy.js');
const { repairUnits } = await import('../../src/lib/unit-repair.js');
const { ensureBundledLessons, BUNDLED_COURSE, BUNDLED_LESSONS } = await import('../../src/lib/bundled-lessons.js');

const app = new Hono().route('/', admin);
const ADMIN = 'usr_unit_admin';
async function api(method, path, body) {
  const res = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await signAccessToken(ADMIN, 'admin')}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(res.status, 200, `${method} ${path}: ${await res.clone().text()}`);
  return res.json();
}
const unit = async (id) => (await db.getSyncData('_system', `course:${id}`))?.data;
const placement = async () => buildHierarchy(await db.getAllSyncData('_system'));

async function oldReleaseRename(unitId, name) {
  const current = await db.getSyncData('_system', `course:${unitId}`);
  await db.putSyncData('_system', `course:${unitId}`, {
    name,
    createdBy: current?.data?.createdBy || ADMIN,
    createdByName: current?.data?.createdByName || 'admin',
    createdAt: current?.data?.createdAt || '2026-11-01T00:00:00.000Z',
    updatedBy: ADMIN,
    updatedByName: 'admin',
  }, current?.version || 0);
}

const MARKDOWN = (title) => `# ${title}\n\nOrientation.\n\n## Exemplar\n\nA message.\n\n## Learning Objectives\n\n- Can do one\n- Can do two\n`;

beforeEach(async () => {
  if (!await db.getUserById(ADMIN)) await db.createUser({ userId: ADMIN, email: 'unit-admin@example.test', passwordHash: 'x', role: 'admin' });
  for (const i of await db.getAllSyncData('_system')) await db.deleteSyncData('_system', i.dataKey);
});

async function courseWithOrderedUnit() {
  await api('PUT', '/v1/admin/programs/p1', { name: 'Course One' });
  await api('PUT', '/v1/admin/units/u1', { name: 'Unit A', programId: 'p1' });
  for (const [id, name] of [['l1', 'Lesson 1'], ['l2', 'Lesson 2'], ['l3', 'Lesson 3']]) {
    await db.createSyncData('_system', `lesson:${id}`, { name, course: 'u1', status: 'public', markdown: `# ${name}` });
  }
  await api('PUT', '/v1/admin/units/u1/order', { lessonIds: ['l3', 'l1', 'l2'] });
}

describe('repairing units an older release rewrote', () => {
  it('puts back the course and the custom lesson order, and keeps the new name', async () => {
    await courseWithOrderedUnit();
    await oldReleaseRename('u1', 'Unit A (renamed during a rollback)');
    let h = await placement();
    assert.deepEqual([h.units.get('u1').programId, h.units.get('u1').lessonIds], [null, ['l1', 'l2', 'l3']], 'the bug: unassigned, alphabetical');

    assert.deepEqual(await repairUnits({ db }), { repaired: ['u1'], ambiguous: [] });
    const repaired = await unit('u1');
    assert.deepEqual([repaired.name, repaired.programId, repaired.lessonIds], ['Unit A (renamed during a rollback)', 'p1', ['l3', 'l1', 'l2']]);
    h = await placement();
    assert.deepEqual(h.programs.find((p) => p.id === 'p1').unitIds, ['u1']);
    assert.deepEqual(h.units.get('u1').lessonIds, ['l3', 'l1', 'l2']);

    assert.deepEqual(await repairUnits({ db }), { repaired: [], ambiguous: [] }, 'a second start changes nothing');
  });

  it('a unit moved to another course takes its order copy along; deleting the unit drops it', async () => {
    await courseWithOrderedUnit();
    await api('PUT', '/v1/admin/programs/p2', { name: 'Course Two' });
    await api('PUT', '/v1/admin/units/u1', { name: 'Unit A', programId: 'p2' });
    const course = async (id) => (await db.getSyncData('_system', `program:${id}`)).data;
    assert.deepEqual((await course('p1')).lessonOrder, {});
    assert.deepEqual((await course('p2')).lessonOrder, { u1: ['l3', 'l1', 'l2'] });
    await oldReleaseRename('u1', 'Unit A');
    await repairUnits({ db });
    assert.deepEqual([(await unit('u1')).programId, (await unit('u1')).lessonIds], ['p2', ['l3', 'l1', 'l2']]);
    await api('DELETE', '/v1/admin/units/u1');
    assert.deepEqual((await course('p2')).lessonOrder, {});
  });

  it("leaves an admin's own unassignment, an unlisted unit, and a unit two courses list", async () => {
    await courseWithOrderedUnit();
    await api('PUT', '/v1/admin/units/u1', { name: 'Unit A', programId: null });
    assert.equal((await unit('u1')).programId, null);
    await db.createSyncData('_system', 'course:u-loose', { name: 'Never in a course' });
    await db.createSyncData('_system', 'program:pa', { name: 'A', unitIds: ['u-both'] });
    await db.createSyncData('_system', 'program:pb', { name: 'B', unitIds: ['u-both'] });
    await db.createSyncData('_system', 'course:u-both', { name: 'Listed twice' });
    assert.deepEqual(await repairUnits({ db }), { repaired: [], ambiguous: ['u-both'] });
    assert.equal((await unit('u1')).programId, null, 'explicit null stays');
    assert.equal((await unit('u-loose')).programId, undefined);
    assert.equal((await unit('u-both')).programId, undefined);
  });

  it('the Getting Started unit gets its course, marker, and order back', async () => {
    const read = (file) => MARKDOWN(file);
    await ensureBundledLessons({ db, read });
    const unitId = BUNDLED_COURSE.unitId;
    await oldReleaseRename(unitId, 'Orientation');
    assert.deepEqual(await repairUnits({ db }), { repaired: [unitId], ambiguous: [] });
    const restored = await unit(unitId);
    assert.deepEqual([restored.name, restored.programId, restored.lessonIds, restored.bundled],
      ['Orientation', BUNDLED_COURSE.programId, BUNDLED_LESSONS.map((b) => b.id), { id: BUNDLED_COURSE.id }]);

    // An admin's own order for it comes back instead of the canonical one.
    const custom = BUNDLED_LESSONS.map((b) => b.id).reverse();
    await api('PUT', `/v1/admin/units/${unitId}/order`, { lessonIds: custom });
    await oldReleaseRename(unitId, 'Orientation');
    await repairUnits({ db });
    assert.deepEqual((await unit(unitId)).lessonIds, custom);
  });

  it('a unit that changes after it was read is left for the next start', async () => {
    await courseWithOrderedUnit();
    await oldReleaseRename('u1', 'Unit A');
    const racing = { ...db, putSyncData: async () => { throw Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' }); } };
    assert.deepEqual(await repairUnits({ db: racing }), { repaired: [], ambiguous: [] });
    assert.deepEqual(await repairUnits({ db }), { repaired: ['u1'], ambiguous: [] });
  });
});
