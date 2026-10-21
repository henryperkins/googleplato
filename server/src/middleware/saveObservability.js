import { createHash } from 'node:crypto';
import { logger } from '../lib/logger.js';

export const actorRef = userId => createHash('sha256').update(userId).digest('hex');

// Record outcomes, never request bodies, data keys, URLs with IDs, or error text.
// A batch's HTTP 200 is not proof that its individual records were accepted.
export async function observeSyncSave(c, next) {
  await next();
  if (!['PUT', 'POST', 'DELETE'].includes(c.req.method)) return;
  try {
    const operation = c.req.path.startsWith('/v1/sync/lesson-turn/') ? 'lesson_turn'
      : c.req.path === '/v1/sync/batch' ? 'sync_batch'
        : c.req.method === 'DELETE' ? 'sync_delete' : 'sync_write';
    const meta = { source: 'server', operation, method: c.req.method, actorRef: actorRef(c.get('userId')) };
    if (c.res.status >= 400 && c.res.status < 500) {
      const body = await c.res.clone().json().catch(() => ({}));
      const upgrade = body?.code === 'client_upgrade_required';
      const conflict = c.res.status === 409 && !upgrade;
      logger.warn(conflict ? 'sync_conflict' : 'sync_validation_failure', {
        ...meta, status: c.res.status,
        reason: upgrade ? 'client_upgrade_required' : conflict ? 'conditional_write' : 'request_rejected',
      });
    } else if (operation === 'sync_batch' && c.res.ok) {
      const body = await c.res.clone().json();
      for (const [itemIndex, item] of (body.results || []).entries()) {
        if (item.status === 'ok') continue;
        const conflict = item.status === 'conflict';
        logger.warn(conflict ? 'sync_conflict' : 'sync_validation_failure', {
          ...meta, status: 200, itemIndex, reason: conflict ? 'conditional_write' : 'item_rejected',
        });
      }
    }
  } catch { /* Observability must not change the save response. */ }
}
