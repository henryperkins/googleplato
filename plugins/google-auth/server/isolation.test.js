import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from '../../../server/src/lib/plugins/registry.js';
import { makePluginDispatcher } from '../../../server/src/lib/plugins/dispatcher.js';
import { _reset as resetHooks } from '../../../server/src/lib/plugins/hooks.js';

const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const initial = {
  'google-auth': { enabled: false, settings: { projectId: 'private-project' } },
  slack: { enabled: false, settings: {} },
  'teacher-comments': { enabled: false, settings: {} },
  'wordpress-info': { enabled: false, settings: {} },
};

function activationDb() {
  let item = { data: structuredClone(initial), version: 1 };
  return {
    async getSyncData(_userId, key) {
      return key === 'plugins:activation' ? structuredClone(item) : null;
    },
    async putSyncData(_userId, key, data, version, options) {
      assert.equal(key, 'plugins:activation');
      assert.equal(version, item.version);
      assert.deepEqual(options, { strictVersion: true });
      item = { data: structuredClone(data), version: version + 1 };
      return { version: item.version };
    },
    async getUserById() { return null; },
    async listAllUsers() { return []; },
  };
}

after(() => resetHooks());

describe('google-auth activation isolation', () => {
  it('exposes no provider, route, or server-module evaluation while disabled', async () => {
    const registry = createRegistry({ db: activationDb(), pluginsDir });
    await registry.boot();
    assert.equal(registry.get('google-auth').enabled, false);
    assert.equal(registry.get('google-auth').serverLoaded, false);
    assert.deepEqual(await registry.publicAuthProviders(), []);

    const app = new Hono();
    app.all('/v1/plugins/:pluginId/*', makePluginDispatcher(registry));
    const exchange = () => app.request('/v1/plugins/google-auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal((await exchange()).status, 404);
    assert.equal(registry.get('google-auth').serverLoaded, false);

    await registry.setEnabled('google-auth', true);
    assert.equal(registry.get('google-auth').serverLoaded, true);
    assert.deepEqual(await registry.publicAuthProviders(), [{
      id: 'google-auth',
      label: 'Google',
      config: {
        apiKey: 'AIzaSyDqsndJNzd-s4c-xcNB7lCVjH8ITu3yOLY',
        authDomain: 'idk-4e9b9.firebaseapp.com',
        projectId: 'private-project',
        appId: '1:790704980390:web:7c0bfd1a2868f6f3fc4f67',
        messagingSenderId: '790704980390',
      },
    }]);
    assert.equal((await exchange()).status, 400, 'the enabled exchange validates input');

    await registry.setEnabled('google-auth', false);
    assert.equal((await exchange()).status, 404);
    assert.deepEqual(await registry.publicAuthProviders(), []);
  });
});
