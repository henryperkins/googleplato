import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaveObserver } from '../js/saveObservability.js';
function setup() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let user = 'one', online = false;
  const sent = [];
  const options = { storage: () => storage, getUser: async () => user,
    send: async body => { if (!online) throw new TypeError('offline'); sent.push(body); return { ok: true }; } };
  return { options, sent, setUser: value => { user = value; }, connect: () => { online = true; } };
}
const failed = { userId: 'one', operation: 'lesson_turn', key: 'private lesson and turn', ok: false, reason: 'network', status: 0 };
test('offline failures and confirmed recovery survive reload with one incident and no content in events', async () => {
  const f = setup();
  const first = createSaveObserver(f.options);
  first.record(failed);
  await first.flush('one');
  f.connect();
  const reloaded = createSaveObserver(f.options);
  reloaded.record({ ...failed, ok: true });
  await reloaded.flush('one');
  const events = f.sent.flatMap(body => body.events);
  assert.deepEqual(events.map(e => e.code), ['client_save_unconfirmed', 'client_save_recovered']);
  assert.equal(events[0].incidentId, events[1].incidentId);
  assert.doesNotMatch(JSON.stringify(events), /private lesson|reply|token/);
  reloaded.record({ ...failed, ok: true });
  await reloaded.flush('one');
  assert.equal(f.sent.flatMap(body => body.events).length, 2);
});
test('a new account never uploads the prior account queue', async () => {
  const f = setup(); const observer = createSaveObserver(f.options);
  observer.record(failed); await observer.flush('one');
  f.setUser('two'); f.connect(); await observer.flush('one');
  assert.equal(f.sent.length, 0);
  f.setUser('one'); await observer.flush('one'); assert.equal(f.sent.length, 1);
});
test('storage and telemetry failures never throw and do not manufacture recovery', async () => {
  const observer = createSaveObserver({ storage: () => { throw new Error('quota'); }, getUser: async () => 'one', send: async () => { throw new Error('unavailable'); } });
  assert.doesNotThrow(() => observer.record({ ...failed, ok: true }));
  assert.doesNotThrow(() => observer.record(failed));
  await assert.doesNotReject(observer.flush('one'));
});
test('outbox is bounded during a long outage', async () => {
  const f = setup(); const observer = createSaveObserver(f.options);
  for (let i = 0; i < 100; i++) observer.record({ ...failed, key: `turn-${i}` });
  await observer.flush('one'); f.connect(); await observer.flush('one');
  assert.ok(f.sent.flatMap(body => body.events).length <= 50);
  assert.ok(f.sent.every(body => body.events.length <= 20));
});

test('telemetry 401 never refreshes credentials or expires the application session', async () => {
  const { saveObserver } = await import('../js/saveObservability.js');
  const values = new Map();
  const tokens = JSON.stringify({ accessToken: 'old', refreshToken: 'valid-refresh', user: { userId: 'telemetry-owner' } });
  globalThis.localStorage = { getItem: () => tokens };
  globalThis.sessionStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const requests = [];
  globalThis.fetch = async url => { requests.push(url); return new Response('{}', { status: 401 }); };
  saveObserver.record({ ...failed, userId: 'telemetry-owner' });
  await saveObserver.flush('telemetry-owner');
  assert.deepEqual(requests, ['/v1/client-events']);
  assert.equal(localStorage.getItem('plato_auth'), tokens);
});
