import { useAuth } from '../../contexts/AuthContext.jsx';
import { can } from '../../lib/permissions.js';
import { useState, useEffect, useCallback, useRef, createElement } from 'react';
import { adminApi } from './adminApi.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { initPluginRegistry, settingsPanelFor, refreshActivation } from '@/lib/plugins/registry.js';
import { capabilityLabel } from '@/lib/plugins/capabilityLabels.js';
import SettingsForm from '@/lib/plugins/SettingsForm.jsx';

/**
 * Plugins page — one card per installed plugin. Settings panel renders inline
 * when the plugin is enabled (matches WordPress / Shopify Apps patterns —
 * disabled plugins are subdued, enabled ones expose their controls inline so
 * admins can verify state at a glance).
 */

export default function AdminPlugins() {
  const { user } = useAuth();
  const readOnly = !can(user, 'plugins.write');
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  // Only the first load replaces the page. Toggles, saves and data deletion
  // update their own card, so drafts and focus elsewhere stay in place.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [registryReady, setRegistryReady] = useState(false);
  const headingRef = useRef(null);

  const load = useCallback(async ({ focusHeading = false } = {}) => {
    setLoading(true);
    try {
      const list = await adminApi('GET', '/v1/admin/plugins');
      // A successful reload removes the alert holding focus; move it first.
      if (focusHeading) headingRef.current?.focus();
      setPlugins(Array.isArray(list) ? list : []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Plugins could not be loaded.');
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    document.title = 'Plugins — plato';
    load();
    initPluginRegistry()
      .catch((e) => console.error('[plato] plugin registry failed to load', e))
      .finally(() => setRegistryReady(true));
  }, [load]);

  async function toggle(pluginId, enabled) {
    const updated = await adminApi('PUT', `/v1/admin/plugins/${pluginId}/activation`, { enabled });
    await refreshActivation();
    setPlugins((current) => current.map((plugin) => (
      plugin.id === pluginId ? { ...plugin, ...updated } : plugin
    )));
  }

  async function saveSettings(pluginId, next) {
    const updated = await adminApi('PUT', `/v1/admin/plugins/${pluginId}/settings`, next);
    await refreshActivation();
    setPlugins((current) => current.map((plugin) => (
      plugin.id === pluginId ? { ...plugin, ...updated } : plugin
    )));
  }

  async function uninstallData(pluginId) {
    await adminApi('POST', `/v1/admin/plugins/${pluginId}/uninstall-data`, { confirm: pluginId });
    await refreshActivation();
  }

  function completeUninstall(pluginId) {
    setPlugins((current) => current.map((plugin) => (
      plugin.id === pluginId ? { ...plugin, hasStoredState: false, settings: {} } : plugin
    )));
  }

  if (loading && !loaded) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground" role="status" aria-live="polite">
        Loading…
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold">Plugins</h1>
        <a href="https://github.com/1111philo/plato/blob/main/docs/plugins/AUTHORING.md" target="_blank" rel="noopener noreferrer" className="touch-target-inline underline underline-offset-4 text-sm">
          Build a plugin
        </a>
      </div>
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-4 py-3 mb-4 text-sm text-danger-foreground" role="alert">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => load({ focusHeading: true })} disabled={loading} focusableWhenDisabled>
            {loading ? 'Reloading…' : 'Reload plugins'}
          </Button>
        </div>
      )}
      {!error && plugins.length === 0 && (
        <p className="text-sm text-muted-foreground">No plugins installed.</p>
      )}

      <div className="space-y-4">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin} readOnly={readOnly}
            registryReady={registryReady}
            onToggle={(enabled) => toggle(plugin.id, enabled)}
            onSaveSettings={(next) => saveSettings(plugin.id, next)}
            onUninstallData={() => uninstallData(plugin.id)}
            onUninstallComplete={() => completeUninstall(plugin.id)}
          />
        ))}
      </div>
    </div>
  );
}

function PluginCard({ plugin, readOnly, registryReady, onToggle, onSaveSettings, onUninstallData, onUninstallComplete }) {
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const [toggleError, setToggleError] = useState(null);
  const [notice, setNotice] = useState('');
  const headingRef = useRef(null);
  const switchRef = useRef(null);
  const focusHeading = useRef(false);
  const customPanel = registryReady ? settingsPanelFor(plugin.id) : null;
  const hasSettingsSurface = !!customPanel || !!plugin.settingsSchema;
  const isDisabled = !plugin.enabled;
  const hasLoadError = !!plugin.loadError;

  useEffect(() => {
    if (!notice || !focusHeading.current) return;
    headingRef.current?.focus();
    focusHeading.current = false;
  }, [notice]);

  async function handleToggle(enabled, { retry = false } = {}) {
    if (togglePending || readOnly || hasLoadError) return;
    setTogglePending(true);
    // A retry keeps its alert, and the focused Try again, until the outcome.
    if (!retry) setToggleError(null);
    setNotice('');
    try {
      await onToggle(enabled);
      // Success removes the alert, so return focus to the switch it was about.
      if (retry) switchRef.current?.focus();
      setToggleError(null);
    } catch (e) {
      setToggleError({ enabled, message: e.message || 'The request failed.' });
    } finally {
      setTogglePending(false);
    }
  }

  async function handleUninstall() {
    await onUninstallData();
    setUninstallOpen(false);
    focusHeading.current = true;
    setNotice(`${plugin.name} data deleted.`);
    onUninstallComplete();
  }
  // Show "Delete plugin data" only when:
  //  - the plugin is currently disabled (forces a deliberate two-step path)
  //  - the plugin has stored state (an activation record exists — proxy for
  //    "may have data to clean up." A plugin that's never been activated has
  //    no entry in `_system:plugins:activation`, so the button hides.)
  //  - the plugin loaded cleanly
  const canUninstall = !readOnly && isDisabled && plugin.hasStoredState && !hasLoadError;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 basis-48 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold">{plugin.name}</h2>
              <span className="text-xs text-muted-foreground">v{plugin.version}</span>
              {hasLoadError && <Badge variant="destructive" className="text-xs">Load error</Badge>}
            </div>
            <p className="max-w-prose text-sm text-muted-foreground">{plugin.description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span role="status" aria-live="polite" className={cn('text-xs font-medium', plugin.enabled ? 'text-foreground' : 'text-muted-foreground')}>
              {togglePending ? (plugin.enabled ? 'Disabling…' : 'Enabling…') : (plugin.enabled ? 'Active' : 'Disabled')}
            </span>
            <Switch
              ref={switchRef}
              checked={!!plugin.enabled}
              onCheckedChange={handleToggle}
              disabled={hasLoadError || readOnly}
              busy={togglePending}
              label={`Enable ${plugin.name}`}
            />
          </div>
        </div>
        {toggleError && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-3 py-2 text-sm text-danger-foreground" role="alert">
            <span>Couldn’t {toggleError.enabled ? 'enable' : 'disable'} {plugin.name}. {toggleError.message}</span>
            <Button variant="outline" size="sm" onClick={() => handleToggle(toggleError.enabled, { retry: true })} disabled={togglePending} focusableWhenDisabled>
              {togglePending ? 'Trying again…' : 'Try again'}
            </Button>
          </div>
        )}
        <span className="sr-only" role="status" aria-live="polite">{notice}</span>
      </CardHeader>

      {plugin.enabled && hasSettingsSurface && (
        <CardContent className="pt-0">
          <fieldset disabled={readOnly} className="min-w-0">
          <Separator className="mb-4" />
          {customPanel
            ? createElement(customPanel, {
                pluginId: plugin.id,
                settings: plugin.settings || {},
                onSave: onSaveSettings,
              })
            : (
              <SettingsForm
                pluginId={plugin.id}
                pluginName={plugin.name}
                schema={plugin.settingsSchema}
                settings={plugin.settings || {}}
                onSave={onSaveSettings}
              />
            )}
          </fieldset>
        </CardContent>
      )}

      {Array.isArray(plugin.capabilities) && plugin.capabilities.length > 0 && (
        <CardContent className="pt-0">
          <details className="group">
            <summary className="touch-target inline-flex items-center cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none">
              <span className="group-open:hidden">Show {plugin.capabilities.length} permission{plugin.capabilities.length === 1 ? '' : 's'}</span>
              <span className="hidden group-open:inline">Hide permissions</span>
            </summary>
            {/* Plain-language labels: the raw capability tokens are the
                developer-facing contract, not something an admin acts on. */}
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {plugin.capabilities.map((cap) => (
                <li key={cap}>{capabilityLabel(cap)}</li>
              ))}
            </ul>
          </details>
        </CardContent>
      )}

      {canUninstall && (
        <CardContent className="pt-0">
          <Separator className="mb-3" />
          <div className="flex flex-col items-start sm:flex-row sm:items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Permanently remove every record this plugin has stored. The plugin code stays installed.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0"
              onClick={() => setUninstallOpen(true)}
            >
              Delete plugin data
            </Button>
          </div>
        </CardContent>
      )}

      {notice && (
        <CardContent className="pt-0">
          <p className="text-sm text-success-foreground">{notice}</p>
        </CardContent>
      )}

      {hasLoadError && (
        <CardContent className="pt-0">
          <p role="alert" className="text-sm text-destructive">
            <strong>Failed to load:</strong> {plugin.loadError}
          </p>
        </CardContent>
      )}
      <UninstallDialog
        plugin={plugin}
        open={uninstallOpen}
        onOpenChange={setUninstallOpen}
        onConfirm={handleUninstall}
      />
    </Card>
  );
}

/**
 * Type-to-confirm dialog before invoking the plugin's data uninstall. Same
 * friction GitHub uses for repo deletion: the destructive button stays
 * disabled until the admin types the plugin id.
 */
function UninstallDialog({ plugin, open, onOpenChange, onConfirm }) {
  const [confirm, setConfirm] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const matches = confirm.trim() === plugin.id;

  // Reset on open/close so previous text doesn't linger.
  useEffect(() => {
    if (!open) {
      setConfirm('');
      setError(null);
      setWorking(false);
    }
  }, [open]);

  async function handleConfirm() {
    if (working || !matches) return;
    setWorking(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e.message);
      setWorking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="sheet">
        <DialogHeader>
          <DialogTitle>Delete {plugin.name} data?</DialogTitle>
          <DialogDescription>
            This permanently removes every record the plugin has stored. The plugin code stays installed,
            but settings and any per-user data the plugin owns are wiped. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor={`confirm-${plugin.id}`}>
            Type <code className="rounded bg-muted px-1 font-mono">{plugin.id}</code> to confirm
          </Label>
          <Input
            id={`confirm-${plugin.id}`}
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            value={confirm}
            readOnly={working}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && matches && !working && !e.nativeEvent.isComposing) { e.preventDefault(); handleConfirm(); } }}
            autoComplete="off"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">{error}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={working} focusableWhenDisabled>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!matches || working}
            focusableWhenDisabled={working}
            onClick={handleConfirm}
          >
            {working ? 'Deleting…' : 'Delete plugin data'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
