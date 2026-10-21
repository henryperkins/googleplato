import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedFetch, logout, onSessionExpired } from '../js/auth.js';
import * as compatibility from '../js/clientCompatibility.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let account;
beforeEach(() => {
  account = { user: { userId: crypto.randomUUID() }, accessToken: 'access', refreshToken: 'refresh' };
  globalThis.localStorage = {
    getItem: () => JSON.stringify(account),
    setItem: (_key, value) => { account = JSON.parse(value); },
    removeItem: () => { account = null; },
  };
});

test('account switch during the first handshake cannot send the old request under the new account', async () => {
  let effects = 0;
  globalThis.fetch = async url => {
    if (url.endsWith('/status')) {
      account = { ...account, user: { userId: 'different-account' }, accessToken: 'other' };
      return json({ protocol: '1', epoch: 'first' });
    }
    effects++;
    return json({});
  };
  await assert.rejects(authenticatedFetch('/v1/sync/profile', { method: 'PUT', body: '{}' }));
  assert.equal(effects, 0);
});

test('sync writes and AI requests carry the negotiated protocol and epoch', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/status')) return json({ protocol: '1', epoch: 'first' });
    requests.push({ url, headers: new Headers(options.headers) });
    return json({ ok: true });
  };
  await authenticatedFetch('/v1/sync/profile', { method: 'PUT', body: '{}' });
  await authenticatedFetch('/v1/ai/messages', { method: 'POST', body: '{}' });
  await authenticatedFetch('/v1/admin/ai-settings/test', { method: 'POST', body: '{}' });
  assert.equal(requests.length, 3);
  for (const { headers } of requests) {
    assert.equal(headers.get('X-Plato-Client-Protocol'), '1');
    assert.equal(headers.get('X-Plato-Client-Epoch'), 'first');
    assert.equal(headers.get('Authorization'), 'Bearer access');
  }
});

test('an upgrade rejection is sticky until reload and never retries a write or model call', async () => {
  let effects = 0;
  let handshakes = 0;
  globalThis.fetch = async url => {
    if (url.endsWith('/logout')) return json({});
    if (url.endsWith('/status')) { handshakes++; return json({ protocol: '1', epoch: 'second' }); }
    effects++;
    return json({ code: 'client_upgrade_required', protocol: '1', epoch: 'second', error: 'Update this page.' }, 409);
  };
  assert.equal((await authenticatedFetch('/v1/sync/profile', { method: 'PUT', body: '{}' })).status, 409);
  await assert.rejects(authenticatedFetch('/v1/ai/messages', { method: 'POST', body: '{}' }), { code: 'client_upgrade_required' });
  await assert.rejects(authenticatedFetch('/v1/admin/ai-settings/test', { method: 'POST', body: '{}' }), { code: 'client_upgrade_required' });
  await assert.rejects(authenticatedFetch('/v1/sync/profile', { method: 'PUT', body: '{}' }), { code: 'client_upgrade_required' });
  const original = structuredClone(account);
  account = { user: { userId: 'other-account' }, accessToken: 'other-access', refreshToken: 'other-refresh' };
  await assert.rejects(authenticatedFetch('/v1/ai/messages', { method: 'POST', body: '{}' }), { code: 'client_upgrade_required' });
  await logout();
  account = original;
  await assert.rejects(authenticatedFetch('/v1/sync/profile', { method: 'PUT', body: '{}' }), { code: 'client_upgrade_required' });
  assert.equal(effects, 1);
  assert.equal(handshakes, 0, 'only a fresh page can negotiate a replacement epoch');
});

test('unknown protocol, incomplete capabilities, and unavailable handshake prevent inference', async () => {
  for (const capability of [{ protocol: '2', epoch: 'new' }, { protocol: '1' }, null]) {
    const page = compatibility.createClientCompatibility();
    const loadStatus = async () => {
      if (!capability) throw new TypeError('Offline');
      return capability;
    };
    await assert.rejects(page.compatibilityHeaders(loadStatus, { mutation: true }));
  }
});

test('a fresh page negotiates a new epoch, while a fenced page still permits recovery reads', async () => {
  const oldPage = compatibility.createClientCompatibility();
  await oldPage.compatibilityHeaders(async () => ({ protocol: '1', epoch: 'first' }));
  oldPage.requireClientUpgrade();
  assert.equal((await oldPage.compatibilityHeaders(() => { throw new Error('Unexpected renegotiation'); }))['X-Plato-Client-Epoch'], 'first');
  const newPage = compatibility.createClientCompatibility();
  assert.equal((await newPage.compatibilityHeaders(async () => ({ protocol: '1', epoch: 'second' }), { mutation: true }))['X-Plato-Client-Epoch'], 'second');
});

test('a rejected protocol permits recovery reads without repeated handshakes', async () => {
  const page = compatibility.createClientCompatibility();
  let checks = 0;
  const status = async () => { checks++; return { protocol: '2', epoch: 'new' }; };
  await assert.rejects(page.compatibilityHeaders(status, { mutation: true }), { code: 'client_upgrade_required' });
  assert.deepEqual(await page.compatibilityHeaders(status), {});
  assert.deepEqual(await page.compatibilityHeaders(status), {});
  await assert.rejects(page.compatibilityHeaders(status, { mutation: true }), { code: 'client_upgrade_required' });
  assert.equal(checks, 1);
});

test('the read discovering a protocol mismatch succeeds while concurrent writes are fenced', async () => {
  const page = compatibility.createClientCompatibility();
  let resolveStatus;
  const pending = new Promise(resolve => { resolveStatus = resolve; });
  let checks = 0;
  const status = () => { checks++; return pending; };
  const read = page.compatibilityHeaders(status);
  const mutation = assert.rejects(page.compatibilityHeaders(status, { mutation: true }), { code: 'client_upgrade_required' });
  resolveStatus({ protocol: '2', epoch: 'new' });
  assert.deepEqual(await read, {});
  await mutation;
  assert.deepEqual(await page.compatibilityHeaders(status), {});
  assert.equal(checks, 1);
  assert.equal(page.isClientUpgradeRequired(), true);
});

test('recovery reads still surface transport failures without declaring an upgrade', async () => {
  const page = compatibility.createClientCompatibility();
  await assert.rejects(page.compatibilityHeaders(async () => { throw new TypeError('Offline'); }), /Offline/);
  assert.equal(page.isClientUpgradeRequired(), false);
});

for (const refreshStatus of [200, 401]) {
  test(`an old account's refresh response (${refreshStatus}) cannot replace or expire the new account`, async () => {
    const next = { user: { userId: 'next-account' }, accessToken: 'next-access', refreshToken: 'next-refresh' };
    let expired = 0;
    const unsubscribe = onSessionExpired(() => { expired++; });
    const sent = [];
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/refresh')) {
        account = structuredClone(next);
        return json({ accessToken: 'old-refreshed', refreshToken: 'old-refresh' }, refreshStatus);
      }
      const bearer = new Headers(options.headers).get('Authorization');
      sent.push(bearer);
      return json({}, bearer === 'Bearer access' ? 401 : 200);
    };
    try {
      await assert.rejects(authenticatedFetch('/v1/me'));
      assert.deepEqual(account, next);
      assert.equal(expired, 0);
      assert.equal((await authenticatedFetch('/v1/me')).status, 200);
      assert.deepEqual(sent, ['Bearer access', 'Bearer next-access']);
    } finally { unsubscribe(); }
  });
}
