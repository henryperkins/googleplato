/**
 * Units an older release rewrote. Beta-RC-232, and this fork's releases from
 * before the launch integration, save a unit (`_system:course:<id>`) by
 * replacing its record with `{ name, created*, updated* }`. A rename made
 * there, during a rollback or by an old instance during a rolling deploy,
 * drops every field those releases don't know:
 * - `programId`: the unit falls out of its course;
 * - `lessonIds`: its lesson order reverts to alphabetical;
 * - `bundled`: the Getting Started unit loses its marker.
 * Migrations don't run again (m004 is recorded as applied) and the bundled
 * course is installed only once, so nothing else would put them back.
 *
 * Those releases never write course records (`_system:program:*`). A course
 * that still lists the unit in `unitIds` therefore says where it belongs, and
 * its `lessonOrder` copy (kept by routes/admin-hierarchy.js) holds the order.
 *
 * Runs on every start, after the bundled course is reconciled (lib/seed.js).
 * Idempotent, and it only fills fields that are absent:
 * - An explicit `programId: null` is an admin's own "not in a course" (the
 *   new routes write it, and drop the unit from the course's `unitIds`), so
 *   it stays.
 * - A unit that two courses both list is left for an admin.
 * - Writes are version-checked; a unit that changed since it was read is
 *   looked at again on the next start.
 */
import defaultDb from './db.js';
import { BUNDLED_COURSE, BUNDLED_LESSONS } from './bundled-lessons.js';

export async function repairUnits({ db = defaultDb } = {}) {
  const result = { repaired: [], ambiguous: [] };
  const items = await db.getAllSyncData('_system');
  const programs = items.filter((i) => i.dataKey.startsWith('program:'));
  for (const item of items) {
    if (!item.dataKey.startsWith('course:')) continue;
    const data = item.data || {};
    if (data.programId !== undefined) continue;
    const unitId = item.dataKey.slice('course:'.length);
    const owners = programs.filter((p) => Array.isArray(p.data?.unitIds) && p.data.unitIds.includes(unitId));
    if (owners.length !== 1) {
      if (owners.length > 1) result.ambiguous.push(unitId);
      continue;
    }
    const [program] = owners;
    const isBundled = unitId === BUNDLED_COURSE.unitId && program.data?.bundled?.id === BUNDLED_COURSE.id;
    const order = program.data?.lessonOrder?.[unitId] || (isBundled ? BUNDLED_LESSONS.map((b) => b.id) : null);
    const next = {
      ...data,
      programId: program.dataKey.slice('program:'.length),
      ...(data.lessonIds === undefined && Array.isArray(order) ? { lessonIds: order } : {}),
      ...(isBundled && !data.bundled ? { bundled: { id: BUNDLED_COURSE.id } } : {}),
    };
    try {
      await db.putSyncData('_system', item.dataKey, next, item.version, { strictVersion: true });
      result.repaired.push(unitId);
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
    }
  }
  return result;
}
