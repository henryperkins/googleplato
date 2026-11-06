/**
 * Authenticated client plugin registry. Only enabled plugin client modules are
 * imported; disabling removes their exports from the render registry.
 */

import { authenticatedFetch } from '../../../js/auth.js';
import { discoverPlugins, loadPluginClient } from './loader.js';
import { resolveSlotComponent, resolveSettingsPanel } from './resolvers.js';

const state = {
  manifests: new Map(),
  modules: new Map(),
  enabled: new Map(),
  loaded: false,
  loadingPromise: null,
};

async function applyActivation(list) {
  const nextEnabled = new Map();
  for (const plugin of list) {
    if (plugin.enabled) nextEnabled.set(plugin.id, plugin);
  }

  await Promise.all([...nextEnabled.keys()].map(async (id) => {
    if (state.modules.has(id)) return;
    try {
      const mod = await loadPluginClient(id);
      if (mod) state.modules.set(id, mod);
    } catch (error) {
      console.error(`[plato] plugin "${id}" client bundle failed to load`, error);
    }
  }));

  state.enabled = nextEnabled;
  for (const id of state.modules.keys()) {
    if (!nextEnabled.has(id)) state.modules.delete(id);
  }
}

async function loadOnce() {
  if (state.loaded) return;
  if (state.loadingPromise) return state.loadingPromise;
  state.loadingPromise = (async () => {
    const { manifests } = await discoverPlugins();
    for (const [id, manifest] of Object.entries(manifests)) state.manifests.set(id, manifest);
    try {
      const res = await authenticatedFetch('/v1/plugins');
      if (res.ok) await applyActivation(await res.json());
    } catch {
      // Public auth slots use PublicAuthProviders instead of authenticatedFetch.
    }
    state.loaded = true;
  })();
  return state.loadingPromise;
}

/** Re-fetch activation and lazily load newly enabled client modules. */
export async function refreshActivation() {
  try {
    const res = await authenticatedFetch('/v1/plugins');
    if (!res.ok) return;
    await applyActivation(await res.json());
  } catch { /* Keep the last confirmed client activation state. */ }
}

export function slotComponents(slotName) {
  const out = [];
  for (const [id] of state.enabled) {
    const Component = resolveSlotComponent(state.modules.get(id), slotName);
    if (Component) out.push({ pluginId: id, Component });
  }
  return out;
}

export function settingsPanelFor(id) {
  return resolveSettingsPanel(state.modules.get(id));
}

export { loadOnce as initPluginRegistry };
