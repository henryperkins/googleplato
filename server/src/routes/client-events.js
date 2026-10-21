import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authenticate } from '../middleware/authenticate.js';
import { actorRef } from '../middleware/saveObservability.js';
import { logger } from '../lib/logger.js';

const clientEvents = new Hono();
const fields = new Set(['code', 'eventId', 'incidentId', 'operation', 'reason', 'status']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasons = new Set(['network', 'timeout', 'conflict', 'upgrade_required', 'rejected', 'invalid_ack', 'unconfirmed']);
const budgets = new Map();
function validEvent(event) {
  return event && typeof event === 'object' && Object.keys(event).every(key => fields.has(key))
    && uuid.test(event.eventId) && uuid.test(event.incidentId)
    && ['lesson_turn', 'sync_write', 'sync_delete'].includes(event.operation)
    && Number.isInteger(event.status) && (event.status === 0 || (event.status >= 200 && event.status <= 599))
    && ((event.code === 'client_save_unconfirmed' && reasons.has(event.reason))
      || (event.code === 'client_save_recovered' && event.reason === 'confirmed'));
}
// Deliberately outside the compatibility fence: an outdated page must be able
// to report its rejection. This authenticated endpoint only emits allowlisted
// metadata; it cannot mutate learner data or invoke inference.
clientEvents.post('/v1/client-events', authenticate, bodyLimit({ maxSize: 16 * 1024 }), async c => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.events) || !body.events.length || body.events.length > 20
    || Object.keys(body).some(key => !['userId', 'events'].includes(key)) || !body.events.every(validEvent)) {
    return c.json({ error: 'Invalid save events' }, 400);
  }
  if (body.userId !== c.get('userId')) return c.json({ error: 'Account changed' }, 403);
  // Per-instance abuse bound, not durable deduplication. eventId supports
  // cross-instance deduplication by the log reader after lost acknowledgements.
  const now = Date.now();
  const key = c.get('userId');
  for (const [id, budget] of budgets) if (budget.until <= now) budgets.delete(id);
  const budget = budgets.get(key) || { count: 0, until: now + 60_000 };
  if (budget.count + body.events.length > 120 || (!budgets.has(key) && budgets.size >= 1000)) {
    return c.json({ error: 'Too many save events' }, 429);
  }
  budget.count += body.events.length;
  budgets.set(key, budget);
  for (const { code, ...event } of body.events) {
    logger[code === 'client_save_recovered' ? 'info' : 'warn'](code, {
      ...event, source: 'client', actorRef: actorRef(key),
    });
  }
  return c.json({ accepted: body.events.length }, 202);
});
export default clientEvents;
