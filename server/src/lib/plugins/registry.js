/**
 * Plugin registry. The default export is the process-wide host; createRegistry()
 * supports independent instances in tests.
 *
 * Activation lives in `_system:plugins:activation`. Writes use strict CAS and
 * change only their target fields. Read surfaces reconcile with consistent
 * storage before dispatch so a warm process cannot keep exposing a remotely
 * disabled plugin or restore stale activation through a settings-only write.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import db from '../db.js';
import { logger } from '../logger.js';
import ai, { LLM } from '../ai-provider.js';
import { normalizeRole } from '../permissions.js';
import { nameFields } from '../names.js';
import { validateManifest } from './manifest.js';
import { satisfies, PLUGIN_API_VERSION } from './version.js';
import { on as hookOn, emit as hookEmit } from './hooks.js';
import { invokeOnActivate, invokeOnDeactivate, invokeOnUninstall } from './lifecycle.js';
import { createPluginLogger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACTIVATION_KEY = 'plugins:activation';
const MAX_WRITE_ATTEMPTS = 4;
const RECONCILE_TTL_MS = 5000;

function findPluginsDir() {
  const candidates = [
    join(__dirname, '../../../../plugins'),
    join(__dirname, '../../../plugins'),
  ];
  for (const path of candidates) {
    if (existsSync(path) && statSync(path).isDirectory()) return path;
  }
  return null;
}

function discoverPluginFolders(pluginsDir) {
  if (!pluginsDir || !existsSync(pluginsDir)) return [];
  const out = [];
  for (const entry of readdirSync(pluginsDir)) {
    const dir = join(pluginsDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(dir, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    out.push({ id: entry, dir, manifestPath });
  }
  return out;
}

function loadManifest(manifestPath, expectedId) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { ok: false, errors: [`failed to parse plugin.json: ${err.message}`] };
  }
  return validateManifest(raw, { expectedId });
}

async function dynamicImportServer(dir, manifest) {
  const ref = manifest.extensionPoints?.serverRoutes;
  const filePath = ref ? join(dir, ref.split('#')[0]) : join(dir, 'server/index.js');
  if (!existsSync(filePath)) {
    if (ref) throw new Error(`serverRoutes file not found: ${filePath}`);
    return null;
  }
  const mod = await import(pathToFileURL(filePath).href);
  return mod.default || mod;
}

function db_view(database) {
  const present = user => user ? { ...user, ...nameFields(user), role: normalizeRole(user.role) } : user;
  return {
    getUserById: async id => present(await database.getUserById(id)),
    listAllUsers: async () => (await database.listAllUsers()).map(present),
  };
}

/** Build a hook/lifecycle context bound to its owning registry. */
export function buildContext(id, settings, registry = pluginRegistry) {
  return {
    pluginId: id,
    logger: createPluginLogger(id),
    db: db_view(registry._db),
    settings: settings || {},
    setSettings: async (next) => {
      await registry.updateSettings(id, next);
    },
    emit: (event, payload) => registry.emit(event, payload),
    ai,
    LLM,
  };
}

function scrubSettings(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  for (const [key, childSchema] of Object.entries(schema?.properties || {})) {
    if (childSchema?.writeOnly) delete out[key];
    else if (Object.hasOwn(out, key)) out[key] = scrubSettings(out[key], childSchema);
  }
  return out;
}

function settingsWithDefaults(entry) {
  const settings = { ...(entry?.settings || {}) };
  for (const [key, schema] of Object.entries(entry?.manifest?.settingsSchema?.properties || {})) {
    if (settings[key] === undefined && schema && Object.hasOwn(schema, 'default')) settings[key] = schema.default;
  }
  return settings;
}

export function createRegistry(options = {}) {
  const database = options.db || db;
  const state = {
    pluginsDir: options.pluginsDir || null,
    entries: new Map(),
    booted: false,
    bootPromise: null,
    reconcilePromise: null,
    activationVersion: -1,
    lastReconciledAt: 0,
  };

  async function readActivation() {
    const item = await database.getSyncData('_system', ACTIVATION_KEY, { consistentRead: true });
    return {
      record: (item?.data && typeof item.data === 'object') ? item.data : {},
      version: item?.version || 0,
    };
  }

  async function writeActivation(record, version) {
    return database.putSyncData('_system', ACTIVATION_KEY, record, version, { strictVersion: true });
  }

  async function mutateActivation(id, mutate) {
    let lastError;
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const activation = await readActivation();
      const record = { ...activation.record };
      record[id] = mutate({ ...(record[id] || {}) }, record);
      try {
        const saved = await writeActivation(record, activation.version);
        return { record, version: saved?.version || activation.version + 1 };
      } catch (error) {
        if (error?.name !== 'ConditionalCheckFailedException') throw error;
        lastError = error;
      }
    }
    throw lastError || new Error('Plugin activation changed concurrently. Retry.');
  }

  function subscribeHooks(id, plugin) {
    const subs = [];
    if (!plugin || !plugin.hooks || typeof plugin.hooks !== 'object') return subs;
    for (const [event, fn] of Object.entries(plugin.hooks)) {
      if (typeof fn !== 'function') continue;
      const wrapped = (payload) => {
        const entry = state.entries.get(id);
        if (!entry?.enabled) return;
        return fn(payload, buildContext(id, entry.settings, registry));
      };
      subs.push(hookOn(event, wrapped, { pluginId: id }));
    }
    return subs;
  }

  function unsubscribeHooks(entry) {
    for (const unsub of entry.hookUnsubs || []) {
      try { unsub(); } catch { /* noop */ }
    }
    entry.hookUnsubs = [];
  }

  async function ensureServerModule(entry) {
    if (entry.serverLoaded || !entry.manifest) return entry.serverModule;
    try {
      entry.serverModule = await dynamicImportServer(entry.dir, entry.manifest);
      entry.serverLoaded = true;
      entry.loadError = null;
      return entry.serverModule;
    } catch (error) {
      entry.loadError = error?.message || String(error);
      entry.enabled = false;
      throw error;
    }
  }

  function queueLifecycle(entry, enabled) {
    entry.lifecycle = (entry.lifecycle || Promise.resolve()).then(async () => {
      // Run every queued transition in order. Skipping a superseded disable
      // would leave its hooks subscribed when the following enable subscribes
      // them again.
      if (enabled) {
        entry.hookUnsubs = subscribeHooks(entry.manifest.id, entry.serverModule);
        await invokeOnActivate(entry.serverModule, buildContext(entry.manifest.id, entry.settings, registry));
      } else {
        unsubscribeHooks(entry);
        await invokeOnDeactivate(entry.serverModule, buildContext(entry.manifest.id, entry.settings, registry));
      }
    });
    return entry.lifecycle;
  }

  async function applyActivation(activation) {
    if (activation.version < state.activationVersion) return;
    state.activationVersion = activation.version;
    state.lastReconciledAt = Date.now();

    for (const entry of state.entries.values()) {
      if (activation.version < state.activationVersion) return;
      if (!entry.manifest || entry.loadError) continue;
      const id = entry.manifest.id;
      const hasRecord = Object.hasOwn(activation.record, id);
      const persisted = hasRecord ? activation.record[id] : {};
      const enabled = typeof persisted.enabled === 'boolean'
        ? persisted.enabled
        : Boolean(entry.manifest.defaultEnabled);
      const settings = (persisted.settings && typeof persisted.settings === 'object' && !Array.isArray(persisted.settings))
        ? persisted.settings
        : {};

      if (enabled && !entry.serverLoaded) {
        try {
          await ensureServerModule(entry);
        } catch (error) {
          logger.error('plugin_load_failed', { pluginId: id, error: error?.message, stack: error?.stack });
        }
      }
      if (activation.version < state.activationVersion) return;

      entry.settings = settings;
      entry.hasStoredState = hasRecord && !persisted.dataUninstalled;
      const nextEnabled = enabled && !entry.loadError;
      if (entry.enabled === nextEnabled) continue;
      entry.enabled = nextEnabled;
      await queueLifecycle(entry, nextEnabled);
    }
  }

  async function boot() {
    if (state.booted) return;
    if (state.bootPromise) return state.bootPromise;
    state.bootPromise = (async () => {
      state.pluginsDir = options.pluginsDir || findPluginsDir();
      if (!state.pluginsDir) {
        logger.warn('plugin_dir_not_found', { searched: 'plugins/' });
        state.booted = true;
        return;
      }
      const folders = discoverPluginFolders(state.pluginsDir);
      if (folders.length === 0) {
        state.booted = true;
        return;
      }

      // Only a successfully read, absent record is a fresh installation. Never
      // turn a transient read failure into manifest-default activation.
      const activation = await readActivation();
      for (const folder of folders) {
        const result = loadManifest(folder.manifestPath, folder.id);
        if (!result.ok) {
          logger.error('plugin_manifest_invalid', { pluginId: folder.id, errors: result.errors });
          state.entries.set(folder.id, {
            manifest: null, dir: folder.dir, serverModule: null, serverLoaded: true,
            enabled: false, settings: {}, hasStoredState: false,
            loadError: result.errors.join('; '), hookUnsubs: [], lifecycle: Promise.resolve(), toggle: Promise.resolve(),
          });
          continue;
        }
        const manifest = result.manifest;
        const loadError = satisfies(PLUGIN_API_VERSION, manifest.apiVersion)
          ? null
          : `apiVersion ${manifest.apiVersion} not satisfied by host ${PLUGIN_API_VERSION}`;
        if (loadError) logger.error('plugin_api_mismatch', { pluginId: manifest.id, host: PLUGIN_API_VERSION, requested: manifest.apiVersion });
        state.entries.set(manifest.id, {
          manifest, dir: folder.dir, serverModule: null, serverLoaded: false,
          enabled: false, settings: {}, hasStoredState: false,
          loadError, hookUnsubs: [], lifecycle: Promise.resolve(), toggle: Promise.resolve(),
        });
      }
      // onActivate may call ctx.setSettings(), which reconciles through here.
      state.booted = true;
      await applyActivation(activation);
      for (const entry of state.entries.values()) {
        if (entry.manifest) logger.warn('plugin_loaded', { pluginId: entry.manifest.id, enabled: entry.enabled });
      }
    })();

    try {
      await state.bootPromise;
    } catch (error) {
      state.booted = false;
      for (const entry of state.entries.values()) unsubscribeHooks(entry);
      state.entries.clear();
      state.activationVersion = -1;
      logger.error('plugin_activation_read_failed', { error: error?.message });
      throw error;
    } finally {
      state.bootPromise = null;
    }
  }

  async function reconcile({ force = false } = {}) {
    if (!state.booted) await boot();
    if (!force && Date.now() - state.lastReconciledAt < RECONCILE_TTL_MS) return;
    if (state.reconcilePromise) return state.reconcilePromise;
    state.reconcilePromise = (async () => {
      const activation = await readActivation();
      await applyActivation(activation);
    })();
    try {
      await state.reconcilePromise;
    } finally {
      state.reconcilePromise = null;
    }
  }

  const registry = {
    _db: database,
    boot,
    reconcile,

    get(id) {
      return state.entries.get(id);
    },

    list() {
      return [...state.entries.values()];
    },

    async setEnabled(id, enabled) {
      await reconcile({ force: true });
      const entry = state.entries.get(id);
      if (!entry) throw new Error(`unknown plugin: ${id}`);
      if (entry.loadError) throw new Error(`plugin "${id}" failed to load: ${entry.loadError}`);

      // A same-process disable/enable pair must not inspect stale state or
      // overlap lifecycle cleanup. Other instances still converge through CAS.
      const operation = (entry.toggle || Promise.resolve()).catch(() => {}).then(async () => {
        await reconcile({ force: true });
        if (enabled) await ensureServerModule(entry);
        if (entry.enabled === enabled) return entry;
        const activation = await mutateActivation(id, (latest) => {
          const next = { ...latest, enabled };
          delete next.dataUninstalled;
          return next;
        });
        await applyActivation(activation);
        return entry;
      });
      entry.toggle = operation;
      return operation;
    },

    async updateSettings(id, nextSettings) {
      if (!nextSettings || typeof nextSettings !== 'object' || Array.isArray(nextSettings)) {
        throw new Error('settings must be an object');
      }
      await reconcile({ force: true });
      const entry = state.entries.get(id);
      if (!entry) throw new Error(`unknown plugin: ${id}`);
      const settings = { ...nextSettings };
      const properties = entry.manifest?.settingsSchema?.properties || {};
      for (const key of Object.keys(properties)) {
        if (typeof settings[key] === 'string' && settings[key].trim() === '') delete settings[key];
      }
      const effective = settingsWithDefaults({ manifest: entry.manifest, settings });
      for (const key of entry.manifest?.settingsSchema?.required || []) {
        const value = effective[key];
        if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
          throw new Error(`${properties[key]?.title || key} is required.`);
        }
      }
      const activation = await mutateActivation(id, (latest) => {
        const next = { ...latest, settings };
        delete next.dataUninstalled;
        return next;
      });
      await applyActivation(activation);
      return entry;
    },

    async uninstallData(id) {
      await reconcile({ force: true });
      const entry = state.entries.get(id);
      if (!entry) throw new Error(`unknown plugin: ${id}`);
      if (entry.loadError) throw new Error(`plugin "${id}" failed to load: ${entry.loadError}`);
      if (entry.enabled) throw new Error(`plugin "${id}" must be disabled before uninstalling data`);
      await ensureServerModule(entry);
      await invokeOnUninstall(entry.serverModule, buildContext(id, entry.settings, registry));

      const activation = await mutateActivation(id, (latest) => {
        const persistedEnabled = typeof latest.enabled === 'boolean'
          ? latest.enabled
          : Boolean(entry.manifest.defaultEnabled);
        if (persistedEnabled) throw new Error(`plugin "${id}" was enabled while its data was being deleted. Disable it and retry.`);
        return { ...latest, enabled: false, settings: {}, dataUninstalled: true };
      });
      await applyActivation(activation);
      return entry;
    },

    publicView(entry) {
      if (!entry) return null;
      if (!entry.manifest) return { id: 'unknown', loadError: entry.loadError };
      const m = entry.manifest;
      return {
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        capabilities: m.capabilities,
        slots: m.extensionPoints?.slots ? Object.keys(m.extensionPoints.slots) : [],
        hooks: m.extensionPoints?.hooks || [],
        hasSettingsSchema: !!m.settingsSchema,
        settingsSchema: m.settingsSchema || null,
        hasStoredState: !!entry.hasStoredState,
        enabled: !!entry.enabled,
        loadError: entry.loadError || null,
      };
    },

    sanitizeSettings(entry, includeDefaults = false) {
      const settings = includeDefaults ? settingsWithDefaults(entry) : entry?.settings || {};
      return scrubSettings(settings, entry?.manifest?.settingsSchema);
    },

    async publicAuthProviders() {
      await reconcile({ force: true });
      const providers = [];
      for (const entry of state.entries.values()) {
        if (!entry.enabled || entry.loadError || !entry.manifest?.extensionPoints?.authProvider) continue;
        const declaration = entry.manifest.extensionPoints.authProvider;
        const settings = settingsWithDefaults(entry);
        const config = {};
        for (const key of declaration.publicSettings || []) {
          const schema = entry.manifest.settingsSchema?.properties?.[key];
          if (schema?.writeOnly || schema?.type === 'object') continue;
          if (settings[key] !== undefined) config[key] = settings[key];
        }
        providers.push({ id: entry.manifest.id, label: declaration.label || entry.manifest.name, config });
      }
      return providers;
    },

    async emit(event, payload) {
      // Core route unit tests do not boot the host. Production entry points do.
      if (!state.booted) return hookEmit(event, payload);
      try {
        await reconcile({ force: true });
      } catch (error) {
        logger.error('plugin_activation_reconcile_failed', { event, error: error?.message });
        return [];
      }
      return hookEmit(event, payload);
    },

    _reset() {
      for (const entry of state.entries.values()) unsubscribeHooks(entry);
      state.entries.clear();
      state.pluginsDir = options.pluginsDir || null;
      state.booted = false;
      state.bootPromise = null;
      state.reconcilePromise = null;
      state.activationVersion = -1;
      state.lastReconciledAt = 0;
    },
  };

  return registry;
}

export const pluginRegistry = createRegistry();
export default pluginRegistry;
