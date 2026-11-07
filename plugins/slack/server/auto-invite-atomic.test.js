import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StaleDocumentClient } from '../../../server/tests/helpers/stale-document-client.js';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const sdk = await import('../../../src/lib/plugins/sdk.js');
const { db, Hono, WebClient, updateUserMeta } = sdk;
const sqlite = { ...db };
const { default: dynamo, setDocumentClientForTests } = await import('../../../server/src/lib/db-dynamodb.js');
const { autoInvite, onUserCreated } = await import('./auto-invite.js');
const { default: plugin } = await import('./index.js');
const { signAccessToken } = await import('../../../server/src/lib/jwt.js');
const app = new Hono().route('/', plugin.routes);
const SETTINGS = { botToken: 'xoxb-synthetic', autoInviteEnabled: true, autoInviteChannelId: 'C1', autoInviteChannelName: 'cohort' };
const PERSON = { userId: 'learner', email: 'learner@example.test' };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const failure = () => Object.assign(new Error('synthetic Slack rejection'), { data: { error: 'not_in_channel' } });
const conflict = () => Object.assign(new Error('version changed'), { name: 'ConditionalCheckFailedException' });

for (const backend of ['sqlite', 'dynamodb']) {
  test(`${backend}: Slack claims through the real SDK`, async t => {
    const adapter = backend === 'sqlite' ? sqlite : { ...dynamo };
    const fake = backend === 'dynamodb' ? new StaleDocumentClient() : null;
    if (fake) setDocumentClientForTests(fake);
    const install = () => Object.assign(db, Object.fromEntries(Object.entries(adapter).map(([key, value]) => [key, typeof value === 'function' ? value.bind(adapter) : value])));
    const originalApiCall = WebClient.prototype.apiCall;
    let transport;
    WebClient.prototype.apiCall = function(method, args) { return transport(method, args); };
    t.after(() => { Object.assign(db, sqlite); WebClient.prototype.apiCall = originalApiCall; });
    let calls;
    async function setup({ second = false } = {}) {
      install();
      if (fake) { fake.rows.clear(); fake.commands.length = 0; }
      else {
        for (const user of await adapter.listAllUsers()) {
          for (const item of await adapter.getAllSyncData(user.userId)) await adapter.deleteSyncData(user.userId, item.dataKey);
          await adapter.deleteUser(user.userId);
        }
        for (const item of await adapter.getAllSyncData('_system')) await adapter.deleteSyncData('_system', item.dataKey);
      }
      for (const [userId, role] of [['admin', 'admin'], ['learner', 'learner'], ...(second ? [['second', 'learner']] : [])]) {
        await adapter.createUser({ userId, role, email: `${userId}@example.test`, name: userId, passwordHash: 'synthetic' });
        if (role === 'learner') await updateUserMeta(userId, 'slack', () => ({ keep: 'unrelated', autoInvite: { status: 'failed', channelId: 'C1', at: '2026-01-01T00:00:00.000Z', error: 'old failure' } }));
      }
      await adapter.putSyncData('_system', 'plugins:activation', { slack: { settings: SETTINGS } }, 0);
      fake?.commitReplicas();
      calls = { lookup: 0, invite: 0 };
      transport = async (method) => {
        if (method === 'users.lookupByEmail') { calls.lookup++; return { ok: true, user: { id: 'U1' } }; }
        if (method === 'conversations.invite') { calls.invite++; return { ok: true }; }
        throw new Error(`Unexpected external method ${method}`);
      };
    }
    const read = async () => (await adapter.getSyncData(PERSON.userId, 'userMeta:slack', { consistentRead: true }))?.data ?? null;
    const retry = async body => app.request('/admin/auto-invite/retry', { method: 'POST', headers: { Authorization: `Bearer ${await signAccessToken('admin', 'admin')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const list = async () => app.request('/admin/auto-invite', { headers: { Authorization: `Bearer ${await signAccessToken('admin', 'admin')}` } });
    const heldTransport = () => {
      const started = gate(); const release = gate();
      transport = async method => {
        if (method === 'users.lookupByEmail') { calls.lookup++; return { ok: true, user: { id: 'U1' } }; }
        if (method === 'conversations.invite') { if (++calls.invite === 1) { started.resolve(); await release.promise; } return { ok: true }; }
        throw new Error(`Unexpected external method ${method}`);
      };
      return { started, release };
    };
    await t.test('two concurrent Retry-all claims make exactly one Slack call', async () => {
      await setup();
      const { started, release } = heldTransport();
      const bothRead = gate();
      const get = db.getSyncData; const put = db.putSyncData;
      let reads = 0; let casLosses = 0;
      db.getSyncData = async (...args) => {
        const row = await get(...args);
        if (args[0] === PERSON.userId && args[1] === 'userMeta:slack' && args[2]?.consistentRead && reads < 2) {
          if (++reads === 2) bothRead.resolve();
          await bothRead.promise;
        }
        return row;
      };
      db.putSyncData = async (...args) => {
        try { return await put(...args); }
        catch (error) { if (error.name === 'ConditionalCheckFailedException') casLosses++; throw error; }
      };
      const first = retry({ all: true }); const second = retry({ all: true });
      await started.promise;
      try {
        const response = await Promise.race([first, second]);
        assert.equal(response.status, 200);
        const counts = await response.json();
        assert.equal(calls.invite, 1);
        assert.equal(counts.in_progress, 1);
        assert.equal(counts.failed, 0);
        assert.equal(casLosses, 1, 'actual adapter rejects one same-version claim');
      } finally { bothRead.resolve(); release.resolve(); await Promise.all([first, second]); install(); }
      assert.equal((await read()).autoInvite.status, 'invited');
    });
    await t.test('row Retry racing the signup hook shares the same claim', async () => {
      await setup();
      const { started, release } = heldTransport();
      const hook = onUserCreated(PERSON, { settings: SETTINGS });
      await started.promise;
      try {
        const response = await retry({ userId: PERSON.userId });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).in_progress, 1);
        assert.equal(calls.invite, 1);
      } finally { release.resolve(); await hook; }
    });
    for (const oldResult of ['success', 'failure']) for (const order of ['old first', 'owner first']) {
      await t.test(`stale ${oldResult}, ${order}: only the new owner publishes`, async () => {
        await setup();
        let time = Date.parse('2026-01-01T00:00:00Z');
        const oldStarted = gate(); const oldRelease = gate(); const ownerStarted = gate(); const ownerRelease = gate();
        let attempts = 0;
        const deps = { now: () => time, lookup: async () => 'U1', invite: async () => {
          if (++attempts === 1) { oldStarted.resolve(); await oldRelease.promise; if (oldResult === 'failure') throw failure(); }
          else { ownerStarted.resolve(); await ownerRelease.promise; if (oldResult === 'success') throw failure(); }
        } };
        const old = autoInvite(PERSON, SETTINGS, deps);
        await oldStarted.promise;
        const oldId = (await read()).autoInvite.attemptId;
        time += 60000;
        const owner = autoInvite(PERSON, SETTINGS, deps);
        await ownerStarted.promise;
        const ownerId = (await read()).autoInvite.attemptId;
        try {
          await updateUserMeta(PERSON.userId, 'slack', current => ({ ...current, keep: 'newer unrelated edit' }));
          if (order === 'old first') { oldRelease.resolve(); await old; ownerRelease.resolve(); await owner; }
          else { ownerRelease.resolve(); await owner; oldRelease.resolve(); await old; }
          const meta = await read();
          assert.equal(meta.autoInvite.status, oldResult === 'success' ? 'failed' : 'invited');
          assert.ok(oldId && ownerId && oldId !== ownerId, 'random owner IDs distinguish attempts');
          assert.equal(meta.autoInvite.attemptId, ownerId);
          assert.equal(meta.keep, 'newer unrelated edit');
          assert.ok(meta.autoInvite.previousAttempt);
          assert.equal(meta.autoInvite.previousAttempt.previousAttempt, undefined);
        } finally { oldRelease.resolve(); ownerRelease.resolve(); await Promise.all([old, owner]); }
      });
    }
    for (const deletion of ['account', 'plugin data']) {
      await t.test(`deleting ${deletion} during Slack leaves no metadata record`, async () => {
        await setup();
        const { started, release } = heldTransport();
        const pending = autoInvite(PERSON, SETTINGS);
        await started.promise;
        await adapter.deleteSyncData(PERSON.userId, 'userMeta:slack');
        if (deletion === 'account') await adapter.deleteUser(PERSON.userId);
        release.resolve();
        await pending;
        assert.equal(await read(), null);
      });
    }
    await t.test('metadata deleted between outcome read and strict write is never recreated', async () => {
      await setup();
      const put = db.putSyncData;
      let removed = false;
      db.putSyncData = async (...args) => {
        if (args[0] === PERSON.userId && args[1] === 'userMeta:slack' && args[2].autoInvite.status === 'invited' && !removed) {
          removed = true;
          await adapter.deleteSyncData(PERSON.userId, 'userMeta:slack');
        }
        return put(...args);
      };
      try { await autoInvite(PERSON, SETTINGS); assert.equal(removed, true); assert.equal(await read(), null); }
      finally { install(); }
    });
    await t.test('claim-time account deletion leaves no metadata or Slack call', async () => {
      await setup();
      await adapter.deleteSyncData(PERSON.userId, 'userMeta:slack');
      const put = db.putSyncData;
      let removed = false;
      db.putSyncData = async (...args) => {
        if (args[0] === PERSON.userId && args[1] === 'userMeta:slack' && args[2].autoInvite?.status === 'pending' && !removed) {
          removed = true;
          await adapter.deleteUser(PERSON.userId);
        }
        return put(...args);
      };
      let lookups = 0;
      try {
        const result = await autoInvite(PERSON, SETTINGS, { lookup: async () => { lookups++; return 'U1'; } });
        assert.equal(removed, true);
        assert.equal(result, null);
        assert.equal(await read(), null);
        assert.equal(lookups, 0);
      } finally { install(); }
    });
    await t.test('claim-time metadata deletion is not recreated by a CAS retry', async () => {
      await setup();
      const put = db.putSyncData;
      let removed = false;
      db.putSyncData = async (...args) => {
        if (args[0] === PERSON.userId && args[1] === 'userMeta:slack' && args[2].autoInvite?.status === 'pending' && !removed) {
          removed = true;
          await adapter.deleteSyncData(PERSON.userId, 'userMeta:slack');
        }
        return put(...args);
      };
      let lookups = 0;
      try {
        const result = await autoInvite(PERSON, SETTINGS, { lookup: async () => { lookups++; return 'U1'; } });
        assert.equal(removed, true);
        assert.equal(result, null);
        assert.equal(await read(), null);
        assert.equal(lookups, 0);
      } finally { install(); }
    });
    await t.test('Retry all counts exhausted CAS conflicts and continues with later users', async () => {
      await setup({ second: true });
      const put = db.putSyncData;
      let conflicts = 0;
      db.putSyncData = async (...args) => { if (args[0] === PERSON.userId) { conflicts++; throw conflict(); } return put(...args); };
      try {
        const response = await retry({ all: true });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { invited: 1, not_in_workspace: 0, failed: 0, skipped: 1, in_progress: 0, conflict: 1 });
        assert.equal(conflicts, 3);
        assert.equal(calls.invite, 1);
      } finally { install(); }
    });
    for (const all of [true, false]) {
      await t.test(`${all ? 'Retry all' : 'row Retry'} counts a per-user storage error`, async () => {
        await setup({ second: true });
        const get = db.getSyncData;
        db.getSyncData = async (...args) => { if (args[0] === PERSON.userId) throw new Error('synthetic storage failure'); return get(...args); };
        try {
          const response = await retry(all ? { all: true } : { userId: PERSON.userId });
          assert.equal(response.status, 200);
          const counts = await response.json();
          assert.equal(counts.failed, 1);
          assert.equal(counts.invited, all ? 1 : 0);
          assert.equal(counts.conflict, 0);
        } finally { install(); }
      });
    }
    await t.test('clock-controlled live lease blocks same channel, and expiry recovers it', async () => {
      await setup();
      let time = Date.parse('2026-01-01T00:00:00Z');
      const started = gate(); const release = gate();
      let attempts = 0;
      const deps = { now: () => time, lookup: async () => 'U1', invite: async () => { if (++attempts === 1) { started.resolve(); await release.promise; } } };
      const first = autoInvite(PERSON, SETTINGS, deps);
      await started.promise;
      try {
        const current = (await read()).autoInvite;
        assert.equal(Date.parse(current.leaseUntil) - Date.parse(current.startedAt), 60000);
        time += 59999;
        assert.equal((await autoInvite(PERSON, SETTINGS, deps)).status, 'in_progress');
        assert.equal(attempts, 1);
        time++;
        assert.equal((await autoInvite(PERSON, SETTINGS, deps)).status, 'invited');
        assert.equal(attempts, 2);
      } finally { release.resolve(); await first; }
      assert.equal((await read()).autoInvite.status, 'invited');
    });
    await t.test('a channel change takes over a live claim and fences its result', async () => {
      await setup();
      const started = gate(); const release = gate();
      const first = autoInvite(PERSON, SETTINGS, { lookup: async () => 'U1', invite: async () => { started.resolve(); await release.promise; } });
      await started.promise;
      try {
        const next = await autoInvite(PERSON, { ...SETTINGS, autoInviteChannelId: 'C2' }, { lookup: async () => 'U1', invite: async () => { throw failure(); } });
        assert.equal(next.status, 'failed');
      } finally { release.resolve(); await first; }
      assert.deepEqual([(await read()).autoInvite.status, (await read()).autoInvite.channelId], ['failed', 'C2']);
    });
    await t.test('list omits previous attempt details and marks a live row In progress', async () => {
      await setup();
      const { started, release } = heldTransport();
      const pending = autoInvite(PERSON, SETTINGS);
      await started.promise;
      try {
        const response = await list();
        assert.equal(response.status, 200);
        const row = (await response.json()).results.find(result => result.userId === PERSON.userId);
        assert.equal(row.inProgress, true);
        assert.equal(row.previousAttempt, undefined);
        assert.equal(row.attemptId, undefined, 'internal owner ID is not list UI data');
      } finally { release.resolve(); await pending; }
      if (fake) {
        const reads = fake.commands.filter(command => command.constructor.name === 'GetCommand' && command.input.Key.userId === PERSON.userId && command.input.ConsistentRead);
        const writes = fake.commands.filter(command => command.constructor.name === 'PutCommand' && command.input.Item.userId === PERSON.userId && command.input.Item.dataKey === 'userMeta:slack');
        assert.ok(reads.length >= 2, 'real SDK strongly reads claim and outcome');
        assert.ok(writes.slice(1).every(command => command.input.ConditionExpression === 'version = :v'), 'real SDK guards writes strictly');
      }
    });
    await t.test('already_in_channel remains success and invited same-channel rows are skipped', async () => {
      await setup();
      transport = async method => {
        if (method === 'users.lookupByEmail') return { ok: true, user: { id: 'U1' } };
        if (method === 'conversations.invite') { calls.invite++; throw Object.assign(new Error('already'), { data: { error: 'already_in_channel' } }); }
        throw new Error(`Unexpected external method ${method}`);
      };
      assert.equal((await autoInvite(PERSON, SETTINGS)).status, 'invited');
      assert.equal(await autoInvite(PERSON, SETTINGS), null);
      assert.equal(calls.invite, 1);
    });
  });
}

test('Slack manifest requires the existing atomic metadata API', () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url)));
  assert.equal(manifest.apiVersion, '^1.6.0');
  assert.equal(manifest.version, '1.2.0');
});
