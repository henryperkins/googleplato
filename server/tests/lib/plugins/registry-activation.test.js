import { describe, it, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRegistry } from '../../../src/lib/plugins/registry.js';
import { _reset as resetHooks } from '../../../src/lib/plugins/hooks.js';

const root = mkdtempSync(join(tmpdir(), 'plato-registry-activation-'));
const eventsKey = '__platoRegistryActivationEvents';

function fixture(manifestPatch = {}) {
  const dir = mkdtempSync(join(root, 'fixture-'));
  const pluginDir = join(dir, 'demo');
  mkdirSync(join(pluginDir, 'server'), { recursive: true });
  const manifest = {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    apiVersion: '1.x',
    description: 'Activation test plugin',
    defaultEnabled: true,
    capabilities: ['settings.read', 'settings.write', 'hook.userCreated', 'hook.userDeleted', 'auth.provider'],
    extensionPoints: {
      hooks: ['userCreated', 'userDeleted'],
      authProvider: { label: 'Demo Login', publicSettings: ['apiKey', 'projectId'] },
    },
    settingsSchema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', default: 'default-public-key' },
        projectId: { type: 'string' },
        credentials: {
          type: 'object',
          properties: {
            token: { type: 'string', writeOnly: true },
            visible: { type: 'string' },
          },
        },
      },
    },
    ...manifestPatch,
  };
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(join(pluginDir, 'server', 'index.js'), `
    const events = globalThis.${eventsKey} ||= [];
    export default {
      hooks: {
        userCreated(payload) { events.push({ type: 'userCreated', payload }); },
        userDeleted(payload) { events.push({ type: 'userDeleted', payload }); },
      },
      async onActivate(ctx) {
        events.push({ type: 'activate', settings: ctx.settings });
        if (ctx.settings.activateSettings) await ctx.setSettings({ ...ctx.settings, activated: true });
      },
      async onDeactivate() { events.push({ type: 'deactivate' }); },
      async onUninstall() { events.push({ type: 'uninstall' }); },
    };
  `);
  return dir;
}

function memoryDb(initial = null) {
  let item = initial ? { data: structuredClone(initial), version: 1 } : null;
  const state = { failReads: 0, failWrites: 0, reads: [], writes: [] };
  return {
    state,
    async getSyncData(_userId, _key, options) {
      state.reads.push(options);
      if (state.failReads > 0) {
        state.failReads--;
        throw new Error('temporary read failure');
      }
      return item ? structuredClone(item) : null;
    },
    async putSyncData(_userId, _key, data, expectedVersion, options) {
      state.writes.push({ expectedVersion, options });
      assert.deepEqual(options, { strictVersion: true });
      if (state.failWrites > 0) {
        state.failWrites--;
        const error = new Error('conflict');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      if ((item?.version || 0) !== expectedVersion) {
        const error = new Error('conflict');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      item = { data: structuredClone(data), version: expectedVersion + 1 };
      return { version: item.version };
    },
    async getUserById() { return null; },
    async listAllUsers() { return []; },
    read() { return item ? structuredClone(item.data) : null; },
  };
}

beforeEach(() => { globalThis[eventsKey] = []; });
afterEach(() => { resetHooks(); });
after(() => {
  resetHooks();
  rmSync(root, { recursive: true, force: true });
  delete globalThis[eventsKey];
});

describe('plugin activation consistency', () => {
  it('preserves persisted activation and settings across independent registries', async () => {
    const pluginsDir = fixture();
    const database = memoryDb({ demo: { enabled: false, settings: { projectId: 'old' } } });
    const a = createRegistry({ db: database, pluginsDir });
    const b = createRegistry({ db: database, pluginsDir });
    await Promise.all([a.boot(), b.boot()]);

    await a.setEnabled('demo', true);
    await b.updateSettings('demo', { projectId: 'new', apiKey: 'from-b' });
    assert.deepEqual(database.read().demo, {
      enabled: true,
      settings: { projectId: 'new', apiKey: 'from-b' },
    });

    await a.updateSettings('demo', { projectId: 'newer' });
    await b.setEnabled('demo', false);
    assert.deepEqual(database.read().demo, {
      enabled: false,
      settings: { projectId: 'newer' },
    });

    await a.reconcile({ force: true });
    assert.equal(a.get('demo').enabled, false);
    assert.deepEqual(a.get('demo').settings, { projectId: 'newer' });
    assert.ok(database.state.reads.every(options => options?.consistentRead === true));
    assert.ok(database.state.writes.every(write => write.options?.strictVersion === true));
  });

  it('retries a strict same-version conflict without restoring stale fields', async () => {
    const database = memoryDb({ demo: { enabled: true, settings: { projectId: 'current' } } });
    const registry = createRegistry({ db: database, pluginsDir: fixture() });
    await registry.boot();
    database.state.failWrites = 1;
    await registry.updateSettings('demo', { projectId: 'replacement' });
    assert.deepEqual(database.read().demo, {
      enabled: true,
      settings: { projectId: 'replacement' },
    });
    assert.equal(database.state.failWrites, 0);
  });

  it('fails closed on activation-read failure and retries boot successfully', async () => {
    const database = memoryDb({ demo: { enabled: false, settings: {} } });
    const registry = createRegistry({ db: database, pluginsDir: fixture() });
    database.state.failReads = 1;
    await assert.rejects(registry.boot(), /temporary read failure/);
    assert.equal(registry.get('demo'), undefined);
    assert.deepEqual(globalThis[eventsKey], [], 'no lifecycle or hooks ran');

    await registry.boot();
    assert.equal(registry.get('demo').enabled, false);
    assert.deepEqual(globalThis[eventsKey], [], 'persisted disable wins over defaultEnabled');
  });

  it('keeps a default-enabled plugin disabled after uninstall and restart', async () => {
    const pluginsDir = fixture();
    const database = memoryDb({ demo: { enabled: false, settings: { projectId: 'secret-free' } } });
    const registry = createRegistry({ db: database, pluginsDir });
    await registry.boot();
    await registry.uninstallData('demo');
    assert.deepEqual(database.read().demo, { enabled: false, settings: {}, dataUninstalled: true });
    assert.equal(registry.publicView(registry.get('demo')).hasStoredState, false);

    const restarted = createRegistry({ db: database, pluginsDir });
    await restarted.boot();
    assert.equal(restarted.get('demo').enabled, false);
    assert.deepEqual(restarted.get('demo').settings, {});
    assert.equal(restarted.publicView(restarted.get('demo')).hasStoredState, false);
  });

  it('allows lifecycle settings writes without deadlocking activation', async () => {
    const database = memoryDb({ demo: { enabled: true, settings: { activateSettings: true } } });
    const registry = createRegistry({ db: database, pluginsDir: fixture() });
    await registry.boot();
    assert.equal(registry.get('demo').enabled, true);
    assert.deepEqual(database.read().demo.settings, { activateSettings: true, activated: true });
  });

  it('serializes rapid disable/enable transitions without duplicating hooks', async () => {
    const database = memoryDb({ demo: { enabled: true, settings: {} } });
    const registry = createRegistry({ db: database, pluginsDir: fixture() });
    await registry.boot();
    globalThis[eventsKey].length = 0;

    const disabling = registry.setEnabled('demo', false);
    const enabling = registry.setEnabled('demo', true);
    await Promise.all([disabling, enabling]);

    assert.equal(registry.get('demo').enabled, true);
    assert.equal(database.read().demo.enabled, true);
    await registry.emit('userCreated', { userId: 'usr_once' });
    const deliveries = globalThis[eventsKey].filter(event => event.type === 'userCreated');
    assert.equal(deliveries.length, 1);
    assert.deepEqual(globalThis[eventsKey].filter(event => event.type === 'deactivate'), [{ type: 'deactivate' }]);
    assert.equal(globalThis[eventsKey].filter(event => event.type === 'activate').length, 1);
  });
});

describe('plugin settings and manifest-declared hooks', () => {
  it('recursively strips writeOnly settings without mutating stored settings', async () => {
    const registry = createRegistry({ db: memoryDb(), pluginsDir: fixture() });
    const settings = {
      apiKey: 'visible',
      credentials: { token: 'do-not-return', visible: 'safe' },
      undeclared: { preserved: true },
    };
    const entry = {
      settings,
      manifest: {
        settingsSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string' },
            credentials: {
              type: 'object',
              properties: { token: { type: 'string', writeOnly: true }, visible: { type: 'string' } },
            },
          },
        },
      },
    };
    assert.deepEqual(registry.sanitizeSettings(entry), {
      apiKey: 'visible',
      credentials: { visible: 'safe' },
      undeclared: { preserved: true },
    });
    assert.equal(settings.credentials.token, 'do-not-return');
  });

  it('includes manifest defaults only when requested', () => {
    const registry = createRegistry({ db: memoryDb(), pluginsDir: fixture() });
    const entry = {
      settings: { projectId: 'stored-project' },
      manifest: {
        settingsSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', default: 'default-key' },
            projectId: { type: 'string', default: 'default-project' },
            secret: { type: 'string', writeOnly: true, default: 'default-secret' },
          },
        },
      },
    };
    assert.deepEqual(registry.sanitizeSettings(entry), { projectId: 'stored-project' });
    assert.deepEqual(registry.sanitizeSettings(entry, true), {
      apiKey: 'default-key',
      projectId: 'stored-project',
    });
    assert.deepEqual(entry.settings, { projectId: 'stored-project' });
  });

  it('persists blank declared strings as absent so manifest defaults apply', async () => {
    const settingsSchema = {
      type: 'object',
      required: ['apiKey', 'projectId', 'enabled', 'retries'],
      properties: {
        apiKey: { type: 'string', default: 'default-public-key' },
        projectId: { type: 'string', default: 'default-project' },
        optionalNote: { type: 'string' },
        enabled: { type: 'boolean' },
        retries: { type: 'number' },
      },
    };
    const database = memoryDb({ demo: { enabled: false, settings: { projectId: 'old' } } });
    const registry = createRegistry({ db: database, pluginsDir: fixture({ settingsSchema }) });
    await registry.boot();
    await registry.updateSettings('demo', {
      apiKey: ' \t ',
      projectId: '\n',
      optionalNote: null,
      enabled: false,
      retries: 0,
      undeclared: '  ',
    });
    assert.deepEqual(database.read().demo.settings, {
      optionalNote: null,
      enabled: false,
      retries: 0,
      undeclared: '  ',
    });
    assert.deepEqual(registry.sanitizeSettings(registry.get('demo'), true), {
      apiKey: 'default-public-key',
      projectId: 'default-project',
      optionalNote: null,
      enabled: false,
      retries: 0,
      undeclared: '  ',
    });
  });

  it('rejects required settings without usable values before writing', async () => {
    const settingsSchema = {
      type: 'object',
      required: ['projectId'],
      properties: {
        apiKey: { type: 'string' },
        projectId: { type: 'string', title: 'Project ID' },
      },
    };
    const database = memoryDb({ demo: { enabled: false, settings: { projectId: 'old' } } });
    const registry = createRegistry({ db: database, pluginsDir: fixture({ settingsSchema }) });
    await registry.boot();
    for (const settings of [{}, { projectId: '  ' }, { projectId: null }]) {
      await assert.rejects(registry.updateSettings('demo', settings), /Project ID is required\./);
    }
    assert.equal(database.state.writes.length, 0);
    assert.deepEqual(database.read().demo.settings, { projectId: 'old' });
  });

  it('loads a manifest-declared userDeleted handler', async () => {
    const database = memoryDb({ demo: { enabled: true, settings: {} } });
    const registry = createRegistry({ db: database, pluginsDir: fixture() });
    await registry.boot();
    await registry.emit('userDeleted', { userId: 'usr_deleted' });
    assert.ok(globalThis[eventsKey].some(event => event.type === 'userDeleted' && event.payload.userId === 'usr_deleted'));
  });

  it('returns only enabled auth providers and allowlisted public config', async () => {
    const database = memoryDb({
      demo: {
        enabled: true,
        settings: { projectId: 'demo-project', credentials: { token: 'secret', visible: 'safe' } },
      },
    });
    const registry = createRegistry({ db: database, pluginsDir: fixture() });
    assert.deepEqual(await registry.publicAuthProviders(), [{
      id: 'demo',
      label: 'Demo Login',
      config: { apiKey: 'default-public-key', projectId: 'demo-project' },
    }]);

    await registry.setEnabled('demo', false);
    assert.deepEqual(await registry.publicAuthProviders(), []);
  });
});
