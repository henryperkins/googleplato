import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { adminApi } from './adminApi.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import CloudflareConnection from './CloudflareConnection.jsx';
import { clearCloudflareDraft, cloudflareAuthorizationUrl, cloudflareReturnFeedback, rememberCloudflareDraft, restoreCloudflareDraft } from '../../lib/cloudflareConnection.js';
import { connectionTestErrorMessage } from '../../lib/aiSettingsFeedback.js';
import { clearAiSettingsDraft, rememberAiSettingsDraft, restoreAiSettingsDraft } from '../../lib/aiSettingsDraft.js';
import {
  aiConfigurationKey, aiConfigurationLabel, aiModelName, bedrockCredentialWarning, pendingAiSettingsChanges,
  requireAiSettingsResponse, savedAiSettingsMessage, testedAiConfiguration,
} from '../../lib/aiSettingsPresentation.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

const PROVIDERS = [
  { id: 'bedrock', name: 'Amazon Bedrock', description: 'Uses the server’s AWS access.' },
  { id: 'workers-ai', name: 'Cloudflare Workers AI', description: 'Connect an account or use server credentials.' },
];

const DEEPSEEK_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const MISTRAL_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

export default function AdminAI() {
  const { user } = useAuth();
  const userId = user?.userId;
  const [settings, setSettings] = useState(null);
  const [provider, setProvider] = useState('bedrock');
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [lastTest, setLastTest] = useState(null);
  const [draftRetained, setDraftRetained] = useState(true);
  const [returnResult] = useState(() => new URLSearchParams(window.location.search).get('cloudflare'));
  const restoredDraft = useRef(false);
  const headingRef = useRef(null);
  const retryRef = useRef(null);
  const saveRef = useRef(null);
  const testRef = useRef(null);
  const reloadRef = useRef(null);
  const connectRef = useRef(null);
  const connectionHeadingRef = useRef(null);
  const focusAfterConnectionUpdate = useRef(null);
  const feedbackRef = useRef(null);
  const feedbackTrigger = useRef(null);
  const requestPending = useRef(false);
  const focusHeadingAfterLoad = useRef(false);
  const requestGeneration = useRef(0);
  const leavingForCloudflare = useRef(false);

  useLayoutEffect(() => {
    if (settings && focusHeadingAfterLoad.current) {
      focusHeadingAfterLoad.current = false;
      headingRef.current?.focus();
    }
    const trigger = focusAfterConnectionUpdate.current;
    focusAfterConnectionUpdate.current = null;
    if (trigger && !trigger.isConnected && document.activeElement === document.body) {
      connectionHeadingRef.current?.focus();
    }
  }, [settings]);

  useLayoutEffect(() => {
    if (!message && !loadError) return;
    const trigger = feedbackTrigger.current;
    const feedback = feedbackRef.current;
    // Keep the result and its trigger visible together, without moving focus
    // or pulling an admin back after they have moved to another control.
    if (!feedback || !trigger?.isConnected || document.activeElement !== trigger) return;
    const main = feedback.closest('main');
    if (!main) return;
    const mainBounds = main.getBoundingClientRect();
    const top = Math.max(0, mainBounds.top);
    const bottom = Math.min(window.innerHeight, mainBounds.bottom);
    const resultBounds = feedback.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    const start = Math.min(resultBounds.top, triggerBounds.top);
    const end = Math.max(resultBounds.bottom, triggerBounds.bottom);
    const gap = 8;
    let delta = 0;
    if (end - start <= bottom - top - gap * 2) {
      if (end > bottom - gap) delta = end - bottom + gap;
      else if (start < top + gap) delta = start - top - gap;
    } else if (triggerBounds.bottom > bottom - gap) {
      delta = triggerBounds.bottom - bottom + gap;
    }
    if (delta) {
      const scroller = /auto|scroll/.test(getComputedStyle(main).overflowY) ? main : document.scrollingElement;
      scroller?.scrollBy({ top: delta, behavior: 'instant' });
    }
  }, [message, loadError]);

  const load = useCallback(({ reloading = false, discarding = false } = {}) => {
    if (requestPending.current) return;
    requestPending.current = true;
    const generation = requestGeneration.current;
    feedbackTrigger.current = reloading ? reloadRef.current : retryRef.current;
    return adminApi('GET', '/v1/admin/ai-settings').then(result => {
      if (generation !== requestGeneration.current) return;
      const data = requireAiSettingsResponse(result);
      // A successful initial retry replaces its button. Move keyboard focus
      // only when the user was still on that button as the response arrived.
      focusHeadingAfterLoad.current = Boolean(retryRef.current && document.activeElement === retryRef.current);
      setSettings(data);
      let restored;
      if (!restoredDraft.current) {
        const local = restoreAiSettingsDraft(browserStorage(), userId, data);
        const handoff = returnResult ? restoreCloudflareDraft(browserStorage(), userId, data) : null;
        restored = local || handoff;
        restoredDraft.current = true;
        if (returnResult) {
          const url = new URL(window.location.href);
          url.searchParams.delete('cloudflare');
          window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
          const feedback = cloudflareReturnFeedback(returnResult, data.workersAiOAuth);
          setMessage(restored?.changed ? { ...feedback, text: `${feedback.text} AI settings changed while you were away; review the current settings before saving.` } : feedback);
        } else if (restored?.changed) {
          setMessage({ error: true, text: 'Saved AI settings changed while you were away. Your earlier choices were not restored; review the current settings before editing.' });
        } else if (restored?.draft) {
          setMessage({ text: 'Your unsaved choices were restored. Save AI settings to apply them.' });
        }
      }
      const next = {
        provider: restored?.draft?.provider || data.provider,
        workersAiModel: restored?.draft?.workersAiModel || data.workersAiModel,
      };
      setProvider(next.provider);
      setModel(next.workersAiModel);
      const hasDraft = pendingAiSettingsChanges(data, next).length > 0;
      setDraftRetained(hasDraft ? rememberAiSettingsDraft(browserStorage(), userId, data, next) : true);
      if (!hasDraft) {
        clearAiSettingsDraft(browserStorage(), userId);
        clearCloudflareDraft(browserStorage(), userId);
      }
      setLoadError('');
      setLastTest(null);
      if (reloading) setMessage({ text: `AI settings reloaded. ${discarding ? 'Unsaved changes were discarded. ' : ''}Active: ${aiConfigurationLabel(data)}.` });
    }).catch(err => {
      if (generation !== requestGeneration.current) return;
      setLoadError(err.message || 'AI settings could not be loaded.');
    }).finally(() => {
      if (generation !== requestGeneration.current) return;
      requestPending.current = false;
      setLoading(false);
    });
  }, [returnResult, userId]);

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    requestPending.current = false;
    restoredDraft.current = false;
    document.title = 'AI Settings — plato';
    load();
    return () => {
      requestGeneration.current = generation + 1;
      requestPending.current = false;
      focusHeadingAfterLoad.current = false;
      focusAfterConnectionUpdate.current = null;
    };
  }, [load]);

  function reloadSettings(options = {}) {
    if (requestPending.current) return;
    setLoading(true);
    setMessage(null);
    if (options.reloading) setLoadError('');
    load(options);
  }

  async function save(event) {
    event.preventDefault();
    if (requestPending.current || !changed || missingCredentials) return;
    requestPending.current = true;
    const generation = requestGeneration.current;
    feedbackTrigger.current = saveRef.current;
    setBusy('save');
    setMessage(null);
    setLoadError('');
    let acknowledged = false;
    try {
      const result = await adminApi('PUT', '/v1/admin/ai-settings', { provider, workersAiModel: model, version: settings.version });
      if (generation !== requestGeneration.current) return;
      acknowledged = true;
      const data = requireAiSettingsResponse(result, { connectionRequired: typeof settings.workersAiOAuth?.connected === 'boolean' });
      setSettings(data);
      setProvider(data.provider);
      setModel(data.workersAiModel);
      clearAiSettingsDraft(browserStorage(), userId);
      clearCloudflareDraft(browserStorage(), userId);
      setDraftRetained(true);
      setMessage({ text: savedAiSettingsMessage(data, changes) });
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setMessage({ error: true, text: acknowledged || !err.status
        ? 'Your save could not be confirmed. Your choices are kept. Reload settings to check before saving again.'
        : err.message });
    } finally {
      if (generation === requestGeneration.current) {
        requestPending.current = false;
        setBusy('');
      }
    }
  }

  async function testConnection() {
    if (requestPending.current || missingCredentials) return;
    requestPending.current = true;
    const generation = requestGeneration.current;
    feedbackTrigger.current = testRef.current;
    const requested = { ...settings, provider, workersAiModel: model };
    setBusy('test');
    setMessage(null);
    setLoadError('');
    try {
      const result = await adminApi('POST', '/v1/admin/ai-settings/test', { provider, workersAiModel: model });
      if (generation !== requestGeneration.current) return;
      const tested = testedAiConfiguration(requested, result);
      if (!result.ok || aiConfigurationKey(tested) !== aiConfigurationKey(requested)) {
        setLastTest(null);
        setMessage({ error: true, text: `The test did not confirm ${aiConfigurationLabel(requested)}. Reload settings, then test again.` });
        return;
      }
      setLastTest({ key: aiConfigurationKey(tested), passed: true, time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) });
      setMessage({ text: `Connection successful: ${aiConfigurationLabel(tested)} returned a response. ${changed ? 'Save AI settings to apply pending changes.' : 'Active settings are unchanged.'}` });
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setLastTest({ key: aiConfigurationKey(requested), passed: false, time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) });
      setMessage({ error: true, text: `${aiModelName(requested)}: ${connectionTestErrorMessage(err, provider)}` });
    } finally {
      if (generation === requestGeneration.current) {
        requestPending.current = false;
        setBusy('');
      }
    }
  }

  function clearFeedback() {
    setMessage(null);
    setLoadError('');
    setLastTest(null);
  }

  function changeSelection(next) {
    if (requestPending.current) return;
    const draft = { provider, workersAiModel: model, ...next };
    setProvider(draft.provider);
    setModel(draft.workersAiModel);
    clearCloudflareDraft(browserStorage(), userId);
    if (pendingAiSettingsChanges(settings, draft).length) {
      setDraftRetained(rememberAiSettingsDraft(browserStorage(), userId, settings, draft));
    } else {
      clearAiSettingsDraft(browserStorage(), userId);
      setDraftRetained(true);
    }
    clearFeedback();
  }

  function browserStorage() {
    try { return window.sessionStorage; } catch { return null; }
  }

  async function connectCloudflare() {
    if (requestPending.current) return;
    feedbackTrigger.current = connectRef.current;
    if (!rememberCloudflareDraft(browserStorage(), userId, settings, { provider, workersAiModel: model })) {
      setMessage({ error: true, text: 'Your browser could not keep your pending choices during sign-in. Allow session storage, then try connecting again.' });
      return;
    }
    requestPending.current = true;
    const generation = requestGeneration.current;
    setBusy('connect');
    clearFeedback();
    try {
      const result = await adminApi('POST', '/v1/admin/ai-settings/cloudflare/connect', {});
      if (generation !== requestGeneration.current) return;
      const authorizationUrl = cloudflareAuthorizationUrl(result?.authorizationUrl);
      leavingForCloudflare.current = true;
      window.location.assign(authorizationUrl);
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      leavingForCloudflare.current = false;
      setMessage({ error: true, text: err.message || 'Cloudflare sign-in could not be opened. Try again.' });
    } finally {
      if (generation === requestGeneration.current) {
        requestPending.current = false;
        setBusy('');
      }
    }
  }

  async function changeCloudflareConnection(action, body, trigger) {
    if (requestPending.current) return;
    requestPending.current = true;
    const generation = requestGeneration.current;
    feedbackTrigger.current = trigger;
    setBusy(action);
    clearFeedback();
    let updated = false;
    try {
      const suffix = action === 'account' ? '/account' : action === 'revoke' ? '/revoke' : '';
      await adminApi(action === 'disconnect' ? 'DELETE' : 'POST', `/v1/admin/ai-settings/cloudflare${suffix}`, body);
      if (generation !== requestGeneration.current) return;
      updated = true;
      const data = requireAiSettingsResponse(await adminApi('GET', '/v1/admin/ai-settings'), { connectionRequired: true });
      if (generation !== requestGeneration.current) return;
      // Updating access must not silently rebase an unsaved provider/model form
      // onto a different administrator's settings version.
      focusAfterConnectionUpdate.current = document.activeElement === trigger ? trigger : null;
      setSettings(current => ({ ...current, workersAiCredentials: data.workersAiCredentials, workersAiOAuth: data.workersAiOAuth }));
      const oauth = data.workersAiOAuth || {};
      setMessage(action === 'account' ? cloudflareReturnFeedback('connected', data.workersAiOAuth) : action === 'revoke' ? {
        text: oauth.revocationPending
          ? 'Previous Cloudflare access still needs to be revoked. Try again later or use Manage Cloudflare authorizations.'
          : 'Previous Cloudflare access was revoked. Your current classroom connection was kept.',
      } : oauth.connected || oauth.needsReconnect || oauth.connectionPending ? {
        error: true, text: 'Cloudflare disconnection could not be confirmed. Reload settings to review the current classroom connection.',
      } : {
        text: oauth.revocationPending
          ? 'Cloudflare was disconnected from Plato. Access could not be revoked at Cloudflare; remove Plato under Manage OAuth authorizations in your Cloudflare profile.'
          : 'Cloudflare was disconnected. The saved AI provider and model have been kept.',
      });
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setMessage({ error: true, text: updated
        ? 'The Cloudflare request completed, but its current status could not be loaded. Your AI choices are kept. Reload settings to confirm.'
        : err.status ? err.message : 'The Cloudflare change could not be confirmed. Your AI choices are kept. Reload settings before trying again.' });
    } finally {
      if (generation === requestGeneration.current) {
        requestPending.current = false;
        setBusy('');
      }
    }
  }

  const candidate = settings && { ...settings, provider, workersAiModel: model };
  const changes = settings ? pendingAiSettingsChanges(settings, { provider, workersAiModel: model }) : [];
  const changed = changes.length > 0;
  const selectedModel = settings?.workersAiModels.find(item => item.id === model);
  const missingCredentials = provider === 'workers-ai' && !settings?.workersAiCredentials.configured;
  const bedrockWarning = bedrockCredentialWarning(settings);
  const showBedrockWarning = provider === 'bedrock' && Boolean(bedrockWarning);
  const pending = loading || Boolean(busy);
  const currentTest = candidate && lastTest?.key === aiConfigurationKey(candidate) ? lastTest : null;
  const feedbackError = Boolean(loadError || message?.error);
  const feedbackText = loading ? 'Reloading AI settings…'
    : busy === 'test' ? `Waiting for ${aiConfigurationLabel(candidate)} to respond…`
    : busy === 'save' ? 'Saving AI settings…'
    : busy === 'connect' ? 'Opening Cloudflare sign-in…'
    : busy === 'account' ? 'Connecting the selected Cloudflare account…'
    : busy === 'disconnect' ? 'Disconnecting Cloudflare…'
    : busy === 'revoke' ? 'Revoking previous Cloudflare access…'
    : loadError ? 'AI settings could not be reloaded. Your selections have been kept. Try reloading again.'
    : message?.text;
  const saveDescription = pending ? 'ai-feedback' : missingCredentials ? 'workers-credentials-help'
    : changed ? `ai-pending-changes${showBedrockWarning ? ' bedrock-credentials-warning' : ''}` : 'ai-save-reason';

  useEffect(() => {
    if (!changed) return;
    const warnBeforeLeaving = event => {
      if (leavingForCloudflare.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [changed]);

  return (
    <div className="space-y-6 wrap-anywhere">
      <div>
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold mb-2">AI Settings</h1>
        <p className="text-sm text-muted-foreground">
          Choose the AI service for coaching, lesson creation, and other AI tools.
        </p>
      </div>

      {!settings && loadError ? (
        <div className="rounded-lg border p-4 space-y-3">
          {loading ? <p role="status">Loading AI settings…</p> : <p role="alert">{loadError}</p>}
          <Button ref={retryRef} variant="outline" onClick={() => reloadSettings()} disabled={loading} focusableWhenDisabled>{loading ? 'Retrying…' : 'Try again'}</Button>
        </div>
      ) : !settings ? <p role="status">Loading AI settings…</p> : (
        <form onSubmit={save} className="space-y-6">
          <section aria-label="Active configuration" className="space-y-1 text-sm">
            <h2 className="font-semibold">Active configuration</h2>
            <p>{aiConfigurationLabel(settings)}</p>
            <p className="text-muted-foreground">{changed ? 'Unsaved changes are listed below.' : 'New requests use this configuration.'}</p>
          </section>

          <fieldset className="min-w-0 space-y-4">
            <legend className="font-semibold mb-3">AI provider</legend>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-3">
              {PROVIDERS.map(item => (
                <label key={item.id} className={`flex min-w-0 gap-3 rounded-lg border p-3 cursor-pointer ${provider === item.id ? 'border-primary bg-primary/5' : ''}`}>
                  <input
                    type="radio"
                    name="ai-provider"
                    value={item.id}
                    checked={provider === item.id}
                    disabled={pending}
                    onChange={() => changeSelection({ provider: item.id })}
                    className="mt-1 size-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{item.name}</span>
                    <span className="block mt-1 text-sm text-muted-foreground">{item.description}</span>
                    {item.id === 'bedrock' && bedrockWarning && provider !== 'bedrock' ? <span className="block mt-1 text-sm text-warning-foreground">No AWS credentials found on this server.</span> : null}
                  </span>
                </label>
              ))}
            </div>

            <section aria-labelledby="ai-model-access-heading" className="space-y-4 border-t pt-4">
              <h2 id="ai-model-access-heading" className="font-semibold">Model and access</h2>
              {provider === 'workers-ai' ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="workers-ai-model">Cloudflare-hosted model</Label>
                    <select
                      id="workers-ai-model"
                      value={model}
                      disabled={pending}
                      onChange={event => changeSelection({ workersAiModel: event.target.value })}
                      aria-describedby="workers-model-description"
                      className="touch-target w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {settings.workersAiModels.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    <p id="workers-model-description" className="text-sm text-muted-foreground">
                      {model === DEEPSEEK_MODEL ? <>Text and image input with <strong>maximum reasoning</strong>. Replies may take longer.</>
                        : model === MISTRAL_MODEL ? 'Text and image input without a reasoning mode.' : selectedModel?.description}
                    </p>
                    {model === DEEPSEEK_MODEL && <p className="text-sm text-muted-foreground">Requires Workers Paid or prepaid AI Gateway credits.</p>}
                    <details className="text-xs text-muted-foreground">
                      <summary className="touch-target-inline w-fit max-w-full cursor-pointer underline underline-offset-4">Model ID</summary>
                      <p className="mt-2 font-mono">{model}</p>
                    </details>
                  </div>
                  <CloudflareConnection
                    key={settings.workersAiOAuth?.pendingFlowId || 'connection'}
                    settings={settings} pending={pending} busy={busy} connectRef={connectRef} headingRef={connectionHeadingRef}
                    onConnect={connectCloudflare}
                    onSelectAccount={(accountId, trigger) => changeCloudflareConnection('account', { accountId, flowId: settings.workersAiOAuth.pendingFlowId }, trigger)}
                    onDisconnect={trigger => changeCloudflareConnection('disconnect', { version: settings.workersAiOAuth.version }, trigger)}
                    onRevoke={trigger => changeCloudflareConnection('revoke', {}, trigger)}
                  />
                </div>
              ) : (
                <div className="space-y-3 text-sm">
                  {showBedrockWarning ? <p id="bedrock-credentials-warning" className="rounded-md border border-warning-border bg-warning px-3 py-2 text-warning-foreground">{bedrockWarning}</p> : null}
                  <p><strong>Model:</strong> {aiModelName(candidate)}</p>
                  <p><strong>AWS region:</strong> {settings.awsRegion}</p>
                  <p className="text-muted-foreground">Your server owner manages the model, region, and access. After server changes, reload settings, then test the connection.</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    <a className="touch-target inline-flex max-w-full items-center underline underline-offset-4" href="https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html" target="_blank" rel="noopener noreferrer">Bedrock setup guide</a>
                    <a className="touch-target inline-flex max-w-full items-center underline underline-offset-4" href="https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html" target="_blank" rel="noopener noreferrer">Model access guide</a>
                  </div>
                </div>
              )}
            </section>
          </fieldset>

          <section aria-label="Review and apply AI settings" className="space-y-3 border-t pt-4">
            {changed ? (
              <section id="ai-pending-changes" aria-label="Pending changes" className="space-y-2 text-sm">
                <h2 className="font-semibold">Pending changes</h2>
                <ul className="space-y-1">
                  {changes.map(change => <li key={change.label}><strong>{change.label}:</strong> {change.before} → {change.after}</li>)}
                </ul>
                {changes.some(change => change.inactive) && <p className="text-muted-foreground">After saving, Amazon Bedrock will be active and this Cloudflare model will be stored for a future switch.</p>}
                <p className={draftRetained ? 'text-muted-foreground' : 'text-warning-foreground'}>{draftRetained
                  ? 'Unsaved choices stay in this tab while the saved settings are unchanged.'
                  : 'This browser cannot keep your choices through a reload. Save before reloading or closing this page.'}</p>
              </section>
            ) : <p id="ai-save-reason" className="text-sm text-muted-foreground">No pending changes to save.</p>}

            <div ref={feedbackRef} id="ai-feedback" className="space-y-1 text-sm">
              <p className="text-muted-foreground">{currentTest ? `Last test ${currentTest.passed ? 'passed' : 'failed'} at ${currentTest.time}. This records that request only.` : 'Not tested in this session.'}</p>
              <p role="status">{!feedbackError ? feedbackText : null}</p>
              <p role="alert" className="text-destructive">{feedbackError ? feedbackText : null}</p>
            </div>
            <p id="ai-test-help" className="text-sm text-muted-foreground">
              Test connection sends a short AI request and may incur usage charges. It does not save changes.
            </p>
            <div className="flex flex-wrap gap-2 [&>button]:h-auto [&>button]:min-h-10 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:py-2">
              <Button ref={saveRef} type="submit" aria-describedby={saveDescription} disabled={pending || !changed || missingCredentials} focusableWhenDisabled>{busy === 'save' ? 'Saving…' : 'Save AI settings'}</Button>
              <Button ref={testRef} type="button" variant="outline" aria-describedby={`ai-test-help ${missingCredentials ? 'workers-credentials-help' : 'ai-feedback'}`} onClick={testConnection} disabled={pending || missingCredentials} focusableWhenDisabled>{busy === 'test' ? 'Testing connection…' : 'Test connection'}</Button>
              <Button ref={reloadRef} type="button" variant="ghost" aria-describedby={changed ? 'ai-pending-changes' : undefined} onClick={() => reloadSettings({ reloading: true, discarding: changed })} disabled={pending} focusableWhenDisabled>{loading ? 'Reloading…' : changed ? 'Discard changes and reload' : 'Reload settings'}</Button>
            </div>
          </section>
        </form>
      )}
    </div>
  );
}
