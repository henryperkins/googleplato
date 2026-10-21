import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import clientEvents from '../../src/routes/client-events.js';
import db from '../../src/lib/db.js';
import { signAccessToken } from '../../src/lib/jwt.js';
import { logger } from '../../src/lib/logger.js';
const app = new Hono().route('/', clientEvents);
const event = (code = 'client_save_unconfirmed') => ({ code, eventId: randomUUID(), incidentId: randomUUID(), operation: 'lesson_turn', reason: code.endsWith('recovered') ? 'confirmed' : 'network', status: 0 });
const body = events => ({ userId: 'usr_event', events });
async function request(value, auth = true) {
  return app.request('/v1/client-events', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${await signAccessToken('usr_event', 'user')}` } : {}) }, body: JSON.stringify(value) });
}
beforeEach(() => { logger._reset(); db.getUserById = async () => ({ userId: 'usr_event', role: 'user' }); });
test('requires authentication and matching ownership even without a compatibility header', async () => {
  assert.equal((await request(body([event()]), false)).status, 401);
  assert.equal((await request({ ...body([event()]), userId: 'other' })).status, 403);
  assert.equal(logger.recent().length, 0);
});
test('accepts only bounded content-free save events and labels recovery as client reported', async () => {
  assert.equal((await request(body([event(), event('client_save_recovered')]))).status, 202);
  const logs = logger.recent(); assert.equal(logs.length, 2);
  assert.equal(logs[0].level, 'info'); assert.equal(logs[0].meta.source, 'client');
  assert.doesNotMatch(JSON.stringify(logs), /usr_event/);
  for (const events of [[{ ...event(), transcript: 'private' }], [event('unhandled_error')], Array.from({ length: 21 }, () => event())]) {
    assert.equal((await request(body(events))).status, 400);
  }
  assert.equal(logger.recent().length, 2);
});
test('rejects oversized telemetry before logging', async () => {
  assert.equal((await request(body([{ ...event(), extra: 'x'.repeat(20000) }]))).status, 413);
  assert.equal(logger.recent().length, 0);
});
