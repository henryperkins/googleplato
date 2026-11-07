/** Basic Slack outcomes through the real SDK; atomic interleavings live in the plugin suite. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { autoInvite, onUserCreated, needsRetry } = await import('../../../plugins/slack/server/auto-invite.js');
const { db, getUserMeta } = await import('../../src/lib/plugins/sdk.js');
const originalPut = db.putSyncData;
const SETTINGS = { botToken: 'xoxb-1', autoInviteEnabled: true, autoInviteChannelId: 'C1', autoInviteChannelName: 'cohort' };
const person = userId => ({ userId, email: 'in@x.com' });
function deps(overrides = {}) {
  const calls = { lookup: 0, invite: 0 };
  return { calls,
    lookup: async (_token, email) => { calls.lookup++; return email === 'in@x.com' ? 'U1' : null; },
    invite: async () => { calls.invite++; }, ...overrides };
}

describe('Slack auto-invite', () => {
  let d;
  beforeEach(async () => {
    db.putSyncData = originalPut;
    for (const user of await db.listAllUsers()) {
      await db.deleteSyncData(user.userId, 'userMeta:slack');
      await db.deleteUser(user.userId);
    }
    for (let i = 1; i <= 9; i++) await db.createUser({ userId: `usr_${i}`, email: `${i}@example.test`, name: 'Synthetic', role: 'learner', passwordHash: 'hash' });
    d = deps();
  });
  it('records a workspace member and skips a successful same-channel retry', async () => {
    const result = await autoInvite(person('usr_1'), SETTINGS, d);
    assert.deepEqual([result.status, result.channelId, result.channelName], ['invited', 'C1', 'cohort']);
    assert.equal((await getUserMeta('usr_1', 'slack')).autoInvite.status, 'invited');
    assert.equal(await autoInvite(person('usr_1'), SETTINGS, d), null);
    assert.equal(d.calls.invite, 1);
  });
  it('a new channel means a new invite', async () => {
    await autoInvite(person('usr_1'), SETTINGS, d);
    await autoInvite(person('usr_1'), { ...SETTINGS, autoInviteChannelId: 'C2' }, d);
    assert.equal(d.calls.invite, 2);
    assert.equal(needsRetry({ autoInvite: { status: 'invited', channelId: 'C1' } }, 'C2'), true);
  });
  it('records missing workspace members and Slack errors, then retries failures', async () => {
    assert.equal((await autoInvite({ userId: 'usr_2', email: 'out@x.com' }, SETTINGS, d)).status, 'not_in_workspace');
    const failing = deps({ invite: async () => { throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } }); } });
    const result = await autoInvite(person('usr_3'), SETTINGS, failing);
    assert.deepEqual([result.status, result.error], ['failed', 'not_in_channel']);
    assert.equal((await autoInvite(person('usr_3'), SETTINGS, { ...failing, invite: async () => {} })).status, 'invited');
  });
  it('records a Slack timeout as a retryable failure', async () => {
    const timedOut = deps({ lookup: async () => { throw new Error('timeout of 4000ms exceeded'); } });
    const result = await autoInvite(person('usr_4'), SETTINGS, timedOut);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /timeout/);
    assert.equal(needsRetry(await getUserMeta('usr_4', 'slack')), true);
    assert.equal(needsRetry({ autoInvite: { status: 'invited' } }), false);
    assert.equal(needsRetry(null), false);
    assert.equal((await autoInvite(person('usr_4'), SETTINGS, d)).status, 'invited');
  });
  it('an outcome write failure leaves a pending attempt recoverable after lease expiry', async () => {
    let writes = 0;
    db.putSyncData = async (...args) => { if (++writes === 2) throw new Error('storage unavailable'); return originalPut(...args); };
    await assert.rejects(autoInvite(person('usr_5'), SETTINGS, { ...d, now: () => 0 }), /storage unavailable/);
    const pending = await getUserMeta('usr_5', 'slack');
    assert.deepEqual([pending.autoInvite.status, pending.autoInvite.channelId], ['pending', 'C1']);
    assert.equal(needsRetry(pending), true);
    db.putSyncData = originalPut;
    assert.equal((await autoInvite(person('usr_5'), SETTINGS, { ...d, now: () => 60000 })).status, 'invited');
  });
  it('does nothing while off, without a channel, or without a token', async () => {
    for (const settings of [{ ...SETTINGS, autoInviteEnabled: false }, { ...SETTINGS, autoInviteChannelId: '' }, { ...SETTINGS, botToken: null }]) {
      assert.equal(await autoInvite(person('usr_1'), settings, d), null);
    }
    assert.equal(d.calls.lookup, 0);
  });
  it('the userCreated hook returns when off and contains storage errors', async () => {
    await onUserCreated(person('usr_9'), { settings: SETTINGS }, { readSettings: async () => ({ ...SETTINGS, botToken: null }) });
    await onUserCreated(person('usr_9'), null, { readSettings: async () => null });
    const messages = [];
    db.putSyncData = async () => { throw new Error('storage unavailable'); };
    try {
      await onUserCreated(person('usr_9'), { settings: SETTINGS, logger: { warn: code => messages.push(code) } });
      assert.deepEqual(messages, ['slack_auto_invite_failed']);
    } finally { db.putSyncData = originalPut; }
  });
});

describe('Slack calls made during signup', () => {
  it('fail at once on a 429 instead of waiting out retry-after', async () => {
    const { createServer } = await import('node:http');
    const { WebClient } = await import('@slack/web-api');
    const { SIGNUP_CALL } = await import('../../../plugins/slack/server/slack-client.js');
    const server = createServer((_req, res) => {
      res.writeHead(429, { 'retry-after': '30', 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"ratelimited"}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const client = new WebClient('xoxb-1', { ...SIGNUP_CALL, slackApiUrl: `http://127.0.0.1:${server.address().port}/api/` });
    const started = Date.now();
    try {
      await assert.rejects(client.users.lookupByEmail({ email: 'a@x.com' }));
      assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    } finally {
      server.close();
    }
  });
});
