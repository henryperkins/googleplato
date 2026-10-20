/**
 * The shared branding request (client/src/lib/publicBranding.js): App starts
 * it at boot so auth pages and the classroom render with their colors
 * instead of each waiting on a request of its own.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let calls = 0;
let respond = () => ({ ok: true, json: async () => ({ classroomName: 'Acme', theme: { primary: '#8b1a1a' } }) });
globalThis.fetch = async (url) => {
  calls += 1;
  assert.equal(url, '/v1/branding');
  return respond();
};

const { loadPublicBranding, cachedPublicBranding, invalidatePublicBranding } = await import('../src/lib/publicBranding.js');

describe('loadPublicBranding', () => {
  beforeEach(() => {
    invalidatePublicBranding();
    calls = 0;
    respond = () => ({ ok: true, json: async () => ({ classroomName: 'Acme', theme: { primary: '#8b1a1a' } }) });
  });

  it('shares one request between pages and caches the result', async () => {
    const [a, b] = await Promise.all([loadPublicBranding(), loadPublicBranding()]);
    assert.equal(calls, 1);
    assert.equal(a.classroomName, 'Acme');
    assert.equal(b, a);
    assert.equal(cachedPublicBranding(), a);
    await loadPublicBranding();
    assert.equal(calls, 1);
  });

  it('falls back to defaults on failure without caching the failure', async () => {
    respond = () => ({ ok: false, json: async () => ({}) });
    assert.deepEqual(await loadPublicBranding(), {});
    assert.equal(cachedPublicBranding(), null);
    respond = () => { throw new TypeError('Failed to fetch'); };
    assert.deepEqual(await loadPublicBranding(), {});
    assert.equal(calls, 2);
  });

  it('refetches after an admin saves new branding', async () => {
    await loadPublicBranding();
    invalidatePublicBranding();
    await loadPublicBranding();
    assert.equal(calls, 2);
  });
});
