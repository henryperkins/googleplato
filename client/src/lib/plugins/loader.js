/**
 * Vite-time plugin discovery. Manifests are eager metadata; client modules are
 * lazy factories and are evaluated only for an enabled plugin. In particular,
 * a disabled public auth provider cannot initialize its provider SDK.
 */

const manifestModules = import.meta.glob('../../../../plugins/*/plugin.json', {
  eager: true,
  import: 'default',
});

const clientModules = import.meta.glob('../../../../plugins/*/client/index.js');

function idFromPath(path) {
  const match = path.match(/\/plugins\/([^/]+)\//);
  return match ? match[1] : null;
}

let discoveryPromise;
let moduleDiscovery;

export async function discoverPlugins() {
  if (!discoveryPromise) {
    discoveryPromise = Promise.resolve().then(() => {
      const manifests = {};
      const modules = {};
      for (const [path, manifest] of Object.entries(manifestModules)) {
        const id = idFromPath(path);
        if (!id || !manifest || typeof manifest !== 'object') continue;
        manifests[id] = manifest;
      }
      for (const [path, load] of Object.entries(clientModules)) {
        const id = idFromPath(path);
        if (id) modules[id] = load;
      }
      moduleDiscovery = modules;
      return { manifests, modules };
    });
  }
  return discoveryPromise;
}

export async function loadPluginClient(id) {
  if (!moduleDiscovery) await discoverPlugins();
  const load = moduleDiscovery?.[id];
  return load ? load() : null;
}
