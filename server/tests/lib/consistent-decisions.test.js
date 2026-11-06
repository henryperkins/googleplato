/**
 * Reads that decide what happens next must be strongly consistent on
 * DynamoDB: the requester's role (authenticate), whether an automation runs,
 * and whether someone unsubscribed. The fake document client below models
 * replication lag: an eventually consistent GetItem returns the value from
 * before the latest write; only ConsistentRead returns the current one.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

process.env.DB_BACKEND = 'dynamodb';
const { setDocumentClientForTests } = await import('../../src/lib/db-dynamodb.js');
const { Hono } = await import('hono');
const { authenticate } = await import('../../src/middleware/authenticate.js');
const { signAccessToken } = await import('../../src/lib/jwt.js');
const n = await import('../../src/lib/notifications.js');

const rows = new Map(); // key → { before, now }
const lagging = (key, before, now) => rows.set(JSON.stringify(key), { before, now });
const sent = [];
before(() => {
  setDocumentClientForTests({
    async send(cmd) {
      if (!(cmd instanceof GetCommand)) throw new Error(`Unexpected ${cmd.constructor.name}`);
      const row = rows.get(JSON.stringify(cmd.input.Key));
      const item = row && (cmd.input.ConsistentRead ? row.now : row.before);
      return item ? { Item: structuredClone(item) } : {};
    },
  });
  n.setEmailTransport(async (raw) => { sent.push(raw); });
});
after(() => n.setEmailTransport(null));

describe('decisions read the latest write', () => {
  it('a demoted admin is refused on the next request', async () => {
    lagging({ userId: 'usr_demoted' },
      { userId: 'usr_demoted', email: 'd@x.com', role: 'admin' },
      { userId: 'usr_demoted', email: 'd@x.com', role: 'learner' });
    const app = new Hono();
    app.use('*', authenticate);
    app.get('/role', (c) => c.json({ role: c.get('role') }));
    const res = await app.request('/role', { headers: { Authorization: `Bearer ${await signAccessToken('usr_demoted', 'admin')}` } });
    assert.deepEqual(await res.json(), { role: 'learner' });
  });

  it('an automation turned off does not run', async () => {
    lagging({ userId: '_system', dataKey: 'automations' },
      { data: { inactivityNudge: true }, version: 1 },
      { data: { inactivityNudge: false }, version: 2 });
    assert.equal((await n.readAutomations()).inactivityNudge, false);
  });

  it('an unsubscribe stops the very next email', async () => {
    lagging({ userId: 'usr_optout', dataKey: 'notify:state' },
      { data: { optOut: {} }, version: 1 },
      { data: { optOut: { nudge: true } }, version: 2 });
    const result = await n.sendTemplated('inactivity-nudge', {
      to: 'learner@x.com', userId: 'usr_optout', kind: 'nudge',
      vars: { firstName: 'Ada', lessonName: 'Lesson', progress: '30%', link: 'https://x.test' },
    });
    assert.deepEqual(result, { optedOut: true });
    assert.equal(sent.length, 0);
    assert.deepEqual((await n.readNotifyState('usr_optout')).optOut, { nudge: true });
  });
});
