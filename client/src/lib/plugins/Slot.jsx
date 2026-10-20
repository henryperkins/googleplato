/**
 * <PluginSlot name="..." context={{ ... }} />
 *
 * Renders every enabled plugin's component for the named slot. Host owns
 * placement; plugins own content. The `context` prop is spread to each
 * component, so host-defined props (e.g. `user` for adminUserRowAction)
 * are passed through directly.
 *
 * Lazy-initializes the registry on first mount of any slot. Each plugin
 * renders inside its own error boundary, so one failing plugin drops out of
 * the slot instead of blanking the host page.
 */

import { Component, useEffect, useState } from 'react';
import { initPluginRegistry, slotComponents } from './registry.js';

let registryLoaded = false;
let registryPromise = null;

class PluginBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error(`[plato] plugin "${this.props.pluginId}" failed to render`, error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function PluginSlot({ name, context = {}, fallback = null }) {
  const [, force] = useState(0);

  useEffect(() => {
    if (registryLoaded) return;
    if (!registryPromise) {
      registryPromise = initPluginRegistry()
        .catch((err) => {
          // A plugin bundle that fails to load leaves its slots empty rather
          // than stuck on the fallback with an unhandled rejection.
          console.error('[plato] plugin registry failed to load', err);
        })
        .then(() => {
          registryLoaded = true;
        });
    }
    registryPromise.then(() => force((n) => n + 1));
  }, []);

  if (!registryLoaded) return fallback;

  const components = slotComponents(name);
  if (components.length === 0) return fallback;

  return (
    <>
      {components.map(({ pluginId, Component: PluginComponent }) => (
        <PluginBoundary key={pluginId} pluginId={pluginId}>
          <PluginComponent pluginId={pluginId} {...context} />
        </PluginBoundary>
      ))}
    </>
  );
}

export default PluginSlot;
