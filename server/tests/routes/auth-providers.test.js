import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import auth from '../../src/routes/auth.js';
import pluginRegistry from '../../src/lib/plugins/registry.js';

const originalDiscovery = pluginRegistry.publicAuthProviders;
afterEach(() => { pluginRegistry.publicAuthProviders = originalDiscovery; });

function appWithAuth() {
  const app = new Hono();
  app.route('/', auth);
  return app;
}

describe('public external-auth discovery', () => {
  it('returns the registry allowlist without requiring a session', async () => {
    pluginRegistry.publicAuthProviders = async () => [{
      id: 'google-auth',
      label: 'Google',
      config: { projectId: 'public-project', apiKey: 'public-browser-key' },
    }];
    const res = await appWithAuth().request('/v1/auth/providers');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{
      id: 'google-auth',
      label: 'Google',
      config: { projectId: 'public-project', apiKey: 'public-browser-key' },
    }]);
  });

  it('returns no providers when every auth plugin is disabled', async () => {
    pluginRegistry.publicAuthProviders = async () => [];
    const res = await appWithAuth().request('/v1/auth/providers');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  it('does not retain the former core Firebase exchange route', async () => {
    const res = await appWithAuth().request('/v1/auth/firebase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'not-a-real-token' }),
    });
    assert.equal(res.status, 404);
  });
});
