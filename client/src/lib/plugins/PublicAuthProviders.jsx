import { Component, useEffect, useState } from 'react';
import { loadPluginClient } from './loader.js';
import { resolveSlotComponent } from './resolvers.js';

class PublicProviderBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error(`[plato] auth provider "${this.props.pluginId}" failed to render`, error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Enabled public auth providers for Login, Setup, and Signup. Provider metadata
 * comes from a public allowlist endpoint; disabled providers are never imported.
 */
export default function PublicAuthProviders({ surface, context = {}, dividerText }) {
  const [providers, setProviders] = useState([]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch('/v1/auth/providers', { signal: controller.signal });
        if (!res.ok) return;
        const discovered = await res.json();
        const loaded = await Promise.all(discovered.map(async provider => {
          try {
            const mod = await loadPluginClient(provider.id);
            const Component = resolveSlotComponent(mod, 'publicAuthProvider');
            return Component ? { provider, Component } : null;
          } catch (error) {
            console.error(`[plato] auth provider "${provider.id}" failed to load`, error);
            return null;
          }
        }));
        if (!controller.signal.aborted) setProviders(loaded.filter(Boolean));
      } catch (error) {
        if (error?.name !== 'AbortError') setProviders([]);
      }
    }
    load();
    return () => controller.abort();
  }, [surface]);

  if (providers.length === 0) return null;

  return (
    <div className="space-y-3">
      {providers.map(({ provider, Component: ProviderComponent }) => (
        <PublicProviderBoundary key={provider.id} pluginId={provider.id}>
          <ProviderComponent
            pluginId={provider.id}
            provider={provider}
            surface={surface}
            {...context}
          />
        </PublicProviderBoundary>
      ))}
      {dividerText && (
        <div className="relative flex items-center py-1">
          <div className="grow border-t border-border" />
          <span className="mx-3 min-w-0 text-center text-xs text-muted-foreground">{dividerText}</span>
          <div className="grow border-t border-border" />
        </div>
      )}
    </div>
  );
}
