/**
 * authenticatedFetch (client/js/auth.js) during "View as User": reads carry
 * ?asUserId=, and EVERY request carries X-Plato-View-As so the server can
 * reject writes (server/src/middleware/viewAsReadOnly.js).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = () => ({
  _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; },
  removeItem(k) { delete this._s[k]; }, clear() { this._s = {}; },
});
globalThis.localStorage = store();
globalThis.sessionStorage = store();
localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'tok', refreshToken: 'ref' }));

let calls = [];
globalThis.fetch = async (url, opts = {}) => { calls.push({ url, headers: Object.fromEntries(new Headers(opts.headers)), method: opts.method || 'GET' }); return new Response(JSON.stringify({ protocol: '1', epoch: 'view-as-test' }), { status: 200 }); };

const { authenticatedFetch } = await import('../js/auth.js');

describe('authenticatedFetch and View as User', () => {
  beforeEach(() => { calls = []; sessionStorage.clear(); });

  it('sends neither the header nor asUserId outside a session', async () => {
    await authenticatedFetch('/v1/sync');
    await authenticatedFetch('/v1/sync/x', { method: 'PUT' });
    for (const c of calls) {
      assert.equal(c.headers['x-plato-view-as'], undefined);
      assert.ok(!c.url.includes('asUserId'));
    }
  });

  it('adds asUserId to reads and the header to every request during a session', async () => {
    sessionStorage.setItem('plato_impersonation', JSON.stringify({ userId: 'usr_target' }));
    await authenticatedFetch('/v1/sync?x=1');
    await assert.rejects(authenticatedFetch('/v1/sync/profile', { method: 'PUT' }), /Writes are not allowed/);
    await authenticatedFetch('/v1/admin/notifications/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const read = calls.find(c => c.url.includes('/v1/sync?'));
    const write = calls.find(c => c.method === 'POST');
    assert.match(read.url, /\/v1\/sync\?x=1&asUserId=usr_target$/);
    assert.equal(read.headers['x-plato-view-as'], 'usr_target');
    assert.ok(!write.url.includes('asUserId'), 'writes never carry asUserId');
    assert.equal(write.headers['x-plato-view-as'], 'usr_target');
    assert.equal(write.headers['content-type'], 'application/json', 'caller headers kept');
    assert.equal(write.headers.authorization, 'Bearer tok');
  });
});
