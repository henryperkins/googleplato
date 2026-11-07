/** Best-effort startup cleanup; never delete an order changed since our read. */
import defaultDb from './db.js';

export async function reconcileUnitOrders({ db = defaultDb } = {}) {
  const result = { removed: [], conflicted: [] };
  const items = await db.getAllSyncData('_system', { consistentRead: true });
  for (const order of items.filter(i => i.dataKey.startsWith('unitOrder:'))) {
    const id = order.dataKey.slice(10);
    const unit = await db.getSyncData('_system', `course:${id}`, { consistentRead: true });
    if (unit && order.data?.unitCreatedAt === (unit.data?.createdAt ?? null)) continue;
    try {
      await db.deleteSyncData('_system', order.dataKey, { expectedVersion: order.version });
      result.removed.push(id);
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
      result.conflicted.push(id);
    }
  }
  return result;
}
