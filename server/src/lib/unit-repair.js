/**
 * Restore owner and bundled metadata dropped by an RC-232 unit rename.
 * Exactly one program must list the unit; explicit null ownership stays put.
 * Lesson ordering is independent, in stamped unitOrder records, and needs no
 * repair. Writes are strictly versioned so concurrent admin edits win.
 */
import defaultDb from './db.js';
import { BUNDLED_COURSE } from './bundled-lessons.js';

export async function repairUnits({ db = defaultDb } = {}) {
  const result = { repaired: [], ambiguous: [], conflicted: [] };
  const items = await db.getAllSyncData('_system', { consistentRead: true });
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
    const next = {
      ...data,
      programId: program.dataKey.slice('program:'.length),
      ...(isBundled && !data.bundled ? { bundled: { id: BUNDLED_COURSE.id } } : {}),
    };
    try {
      await db.putSyncData('_system', item.dataKey, next, item.version, { strictVersion: true });
      result.repaired.push(unitId);
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
      result.conflicted.push(unitId);
    }
  }
  return result;
}
