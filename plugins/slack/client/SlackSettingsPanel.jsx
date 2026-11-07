/**
 * Slack settings panel — rendered as the `adminSettingsPanel` slot inside the
 * plugin card on /plato/plugins.
 *
 * Props (per the SettingsPanel slot contract):
 *   - pluginId: 'slack'
 *   - settings: { workspaceName?, connected?, autoInviteEnabled?, autoInviteChannelId?, autoInviteChannelName? }
 *     (botToken is writeOnly: never sent here; the host keeps it when a save leaves it out)
 *   - onSave: (next) => Promise<void>
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { authenticatedFetch } from '../../../client/js/auth.js';

class SlackRequestError extends Error {
  constructor(message, { status, code, needed } = {}) {
    super(message);
    this.name = 'SlackRequestError';
    this.status = status;
    this.code = code;
    this.needed = needed;
  }
}

async function slackApi(method, path, body) {
  const res = await authenticatedFetch(`/v1/plugins/slack/admin/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SlackRequestError(data.error || `Request failed (${res.status})`, { status: res.status, code: data.code, needed: data.needed });
  }
  return data;
}

// Slack's error codes (forwarded by the plugin's routes) become a cause and a
// next step. Tokens never appear in these messages.
const TOKEN_REJECTED = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired']);

function slackProblem(error) {
  if (error instanceof TypeError) return 'plato couldn’t be reached. Check your connection.';
  if (!(error instanceof SlackRequestError)) return error?.message || 'The request failed.';
  const { code } = error;
  if (code === 'ratelimited' || code === 'slack_webapi_rate_limited_error') return 'Slack is limiting requests. Wait a minute.';
  if (code === 'slack_webapi_request_error' || code === 'slack_webapi_http_error') return 'plato couldn’t reach Slack.';
  if (code && code !== 'slack_webapi_platform_error') return `Slack returned “${code}”.`;
  return error.message;
}

function testFailure(error) {
  if (TOKEN_REJECTED.has(error?.code)) {
    return 'Slack didn’t accept this token. Copy the Bot User OAuth Token, which starts with xoxb-, from your Slack app’s OAuth & Permissions page.';
  }
  return `The connection test failed. ${slackProblem(error)}`;
}

function channelsFailure(error) {
  if (error?.code === 'missing_scope') {
    return `Channels couldn’t be loaded: the Slack app needs the ${error.needed || 'channels:read'} scope. Add it under OAuth & Permissions, reinstall the app, then reload.`;
  }
  if (TOKEN_REJECTED.has(error?.code)) {
    return 'Channels couldn’t be loaded: Slack no longer accepts the saved token. Disconnect Slack, then connect again with a current token.';
  }
  return `Channels couldn’t be loaded. ${slackProblem(error)}`;
}

export default function SlackSettingsPanel({ settings, onSave }) {
  const [token, setToken] = useState('');
  // The last passing test and the exact token it checked. Editing the token
  // withdraws it, so Connect never saves an untested token under the tested
  // workspace's name.
  const [tested, setTested] = useState(null);
  const [workspaceName, setWorkspaceName] = useState(settings?.workspaceName || '');
  const [connected, setConnected] = useState(!!settings?.connected);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const tokenRef = useRef(null);
  const connectedRef = useRef(null);
  const focusAfterChange = useRef(false);
  const currentToken = useRef('');
  const canConnect = !!tested && tested.token === token.trim();

  // Connect and Disconnect each remove the control that had focus. Move it to
  // what replaced that control: the connection status, or the token field.
  useEffect(() => {
    if (!focusAfterChange.current) return;
    focusAfterChange.current = false;
    (connected ? connectedRef : tokenRef).current?.focus();
  }, [connected]);

  function changeToken(value) {
    setToken(value);
    const next = value.trim();
    if (next === currentToken.current) return;
    currentToken.current = next;
    // A test result, or an error, about the previous token no longer applies.
    setTested(null);
    setMessage(null);
  }

  async function handleTest() {
    const candidate = token.trim();
    if (!candidate || testing || saving) return;
    setTesting(true);
    setTested(null);
    setMessage(null);
    try {
      const data = await slackApi('POST', 'test', { botToken: candidate });
      if (currentToken.current !== candidate) return; // Edited while testing.
      if (data.ok && data.team) {
        setTested({ token: candidate, team: data.team });
        setMessage({ text: `Connection test passed for ${data.team}. Connect to save.`, type: 'success' });
      } else {
        setMessage({ text: testFailure(data), type: 'error' });
      }
    } catch (e) {
      if (currentToken.current === candidate) setMessage({ text: testFailure(e), type: 'error' });
    } finally {
      setTesting(false);
    }
  }

  async function handleConnect() {
    if (saving) return;
    if (!canConnect) {
      setMessage({ text: 'Test the connection first.', type: 'error' });
      return;
    }
    const { token: botToken, team } = tested;
    setSaving(true);
    setMessage(null);
    try {
      await onSave({ ...settings, botToken, workspaceName: team, connected: true });
      focusAfterChange.current = true;
      setWorkspaceName(team);
      setConnected(true);
      setTested(null);
      setToken('');
      currentToken.current = '';
      setMessage({ text: 'Slack integration saved.', type: 'success' });
    } catch (e) {
      setMessage({ text: e.message, type: 'error' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await onSave({ ...settings, botToken: null, workspaceName: null, connected: false });
      setDisconnectOpen(false);
      focusAfterChange.current = true;
      setConnected(false);
      setWorkspaceName('');
      setTested(null);
      setToken('');
      currentToken.current = '';
      setMessage({ text: 'Slack disconnected. Auto-invite settings were kept.', type: 'success' });
    } catch (e) {
      setMessage({ text: e.message, type: 'error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="space-y-4">
        {connected ? (
          <>
            <div ref={connectedRef} tabIndex={-1} className="flex items-center gap-2">
              <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full bg-success-foreground" />
              <span className="text-sm">
                Connected to <strong>{workspaceName}</strong>
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              Slack invites are available in the Invite Users dialog on the Users page.
            </p>
            <Button variant="outline" onClick={() => setDisconnectOpen(true)} disabled={saving} focusableWhenDisabled>
              Disconnect Slack
            </Button>
            <AutoInvite settings={settings} onSave={onSave} />
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Connect your Slack workspace to invite users via DM. Create a Slack app at{' '}
              <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="touch-target-inline underline underline-offset-4">api.slack.com/apps</a>,
              install it to your workspace, and paste the Bot User OAuth Token below.
            </p>
            <div className="space-y-2">
              <Label htmlFor="slack-token">Bot User OAuth Token</Label>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  ref={tokenRef}
                  id="slack-token"
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="xoxb-..."
                  value={token}
                  readOnly={saving}
                  onChange={(e) => changeToken(e.target.value)}
                  className="flex-1 font-mono"
                />
                <Button variant="outline" onClick={handleTest} disabled={testing || saving || !token.trim()} focusableWhenDisabled={testing}>
                  {testing ? 'Testing…' : 'Test Connection'}
                </Button>
              </div>
            </div>
            {canConnect && (
              <Button onClick={handleConnect} disabled={saving} focusableWhenDisabled>
                {saving ? 'Saving…' : `Connect to ${tested.team}`}
              </Button>
            )}
          </>
        )}
        <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect Slack?</DialogTitle>
              <DialogDescription>
                Slack DM invitations and automatic channel additions will stop. Your auto-invite settings will be kept, but the bot token will be removed. Reconnect with a bot token to use them again.
              </DialogDescription>
            </DialogHeader>
            {message?.type === 'error' && <p role="alert" className="text-sm text-destructive">{message.text}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDisconnectOpen(false)} disabled={saving} focusableWhenDisabled>Cancel</Button>
              <Button variant="destructive" onClick={handleDisconnect} disabled={saving} focusableWhenDisabled>
                {saving ? 'Disconnecting…' : 'Disconnect Slack'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {/* Always present so screen readers announce its changes; spaced only
          while it has a message. */}
      <p
        role="status"
        aria-live="polite"
        className={`text-sm [&:not(:empty)]:mt-4 ${message?.type === 'error' ? 'text-destructive' : 'text-success-foreground'}`}
      >
        {message?.text || ''}
      </p>
    </div>
  );
}

// Pending rows with a live lease are still running; expired rows can retry.
const STATUS_TEXT = { invited: 'Added', not_in_workspace: 'Not in the workspace', failed: 'Failed', pending: 'Not finished' };
// Phones show the newest results first and the rest on request, so a long
// list neither traps scrolling in a box nor pushes the next plugin far down.
const RESULTS_PREVIEW = 10;

const channelLabel = (channel) => (channel?.name ? `#${channel.name}` : channel?.id || 'the chosen channel');

async function fetchChannels() {
  try {
    const list = await slackApi('GET', 'channels');
    return { list: Array.isArray(list) ? list : [] };
  } catch (e) {
    return { error: channelsFailure(e) };
  }
}

// Auto-invite (#379): add each new plato account to a channel, if the person
// is already in the workspace (matched by email). Results and retries below.
function AutoInvite({ settings, onSave }) {
  const savedEnabled = !!settings?.autoInviteEnabled;
  const savedChannelId = settings?.autoInviteChannelId || '';
  const savedChannelName = settings?.autoInviteChannelName || '';
  const [enabled, setEnabled] = useState(savedEnabled);
  const [channelId, setChannelId] = useState(savedChannelId);
  const [channels, setChannels] = useState(null); // null until the first load settles
  const [channelsError, setChannelsError] = useState(null);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [channelError, setChannelError] = useState(null);
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState(null); // 'save' | 'retry' | null
  const [showAllResults, setShowAllResults] = useState(false);
  const mounted = useRef(false);
  const selectRef = useRef(null);
  const resultsToggleRef = useRef(null);
  const dirty = enabled !== savedEnabled || channelId !== savedChannelId;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchChannels().then(({ list, error }) => {
      if (cancelled) return;
      setChannels(list || []);
      setChannelsError(error || null);
      setLoadingChannels(false);
    });
    slackApi('GET', 'auto-invite').then((d) => { if (!cancelled) setResults(d.results || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function loadResults() {
    try {
      const data = await slackApi('GET', 'auto-invite');
      if (mounted.current) setResults(data.results || []);
    } catch { /* Results are informational; the list keeps what it showed. */ }
  }

  // The saved channel stays a choice when the list failed to load or no longer
  // includes it, so the field never misreports the saved setting and saving
  // keeps its name.
  const listed = channels || [];
  const savedUnlisted = !!savedChannelId && !listed.some((ch) => ch.id === savedChannelId);
  const options = savedUnlisted
    ? [{ id: savedChannelId, name: savedChannelName, notFound: channels !== null && !channelsError }, ...listed]
    : listed;
  const describedBy = [channelError && 'slack-auto-channel-error', channelsError && 'slack-auto-channel-load-error']
    .filter(Boolean).join(' ') || undefined;

  async function reloadChannels() {
    if (loadingChannels) return;
    setLoadingChannels(true);
    const { list, error } = await fetchChannels();
    if (!mounted.current) return;
    // Success removes the error and the Reload button holding focus.
    if (!error) selectRef.current?.focus();
    if (list) setChannels(list);
    setChannelsError(error || null);
    setLoadingChannels(false);
  }

  function changeEnabled(next) {
    setEnabled(next);
    setStatus(null);
    if (!next) setChannelError(null);
  }

  function changeChannel(next) {
    setChannelId(next);
    setStatus(null);
    setChannelError(null);
  }

  async function save() {
    if (pending) return;
    if (enabled && !channelId) {
      setChannelError('Choose a channel for new accounts.');
      setStatus(null);
      selectRef.current?.focus();
      return;
    }
    const channel = options.find((ch) => ch.id === channelId) || null;
    setPending('save');
    setStatus(null);
    try {
      await onSave({
        ...settings,
        autoInviteEnabled: enabled,
        autoInviteChannelId: channelId || null,
        autoInviteChannelName: channel?.name || null,
      });
      setStatus({ type: 'success', text: enabled ? `New accounts will be added to ${channelLabel(channel)}.` : 'Auto-invite is off.' });
    } catch (e) {
      setStatus({ type: 'error', text: e.message || 'Auto-invite settings couldn’t be saved. Try again.' });
    } finally {
      setPending(null);
    }
  }

  async function retry(body, label) {
    if (pending) return;
    setPending('retry');
    setStatus(null);
    try {
      const r = await slackApi('POST', 'auto-invite/retry', body);
      setStatus({ type: 'info', text: `${label}: ${r.invited} added, ${r.not_in_workspace} not in the workspace, ${r.failed} failed, ${r.skipped} skipped, ${r.in_progress} in progress, ${r.conflict} conflicted.` });
      await loadResults();
    } catch (e) {
      setStatus({ type: 'error', text: e.message });
    } finally {
      setPending(null);
    }
  }

  function toggleResults() {
    const next = !showAllResults;
    setShowAllResults(next);
    // Collapsing moves the button back up past the rows it hid; keep it in view.
    if (!next) requestAnimationFrame(() => resultsToggleRef.current?.scrollIntoView({ block: 'nearest' }));
  }

  const retryable = results.filter((r) => !r.inProgress && (r.status !== 'invited' || r.channelId !== settings?.autoInviteChannelId)).length;
  return (
    <section className="border-t pt-4" aria-labelledby="slack-auto-invite">
      <div className="space-y-3">
        <h3 id="slack-auto-invite" className="text-sm font-medium">Add new accounts to a channel</h3>
        <p className="text-sm text-muted-foreground">
          When someone creates a plato account, add them to a channel if they&rsquo;re already in this Slack workspace (matched by email).
          The app needs the <code>users:read.email</code> and <code>channels:manage</code> (or <code>groups:write</code> for a private channel) scopes, and must be in the channel.
        </p>
        <label className="touch-target flex items-center gap-2 text-sm cursor-pointer select-none">
          <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={enabled} onChange={(e) => changeEnabled(e.target.checked)} />
          Add new accounts to a channel
        </label>
        <div className="space-y-1">
          <Label htmlFor="slack-auto-channel">Channel</Label>
          <select
            ref={selectRef}
            id="slack-auto-channel"
            // Until the first load settles, show that it is loading.
            value={channels === null ? '' : channelId}
            onChange={(e) => changeChannel(e.target.value)}
            disabled={channels === null}
            aria-describedby={describedBy}
            aria-invalid={channelError ? true : undefined}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm aria-invalid:border-destructive"
          >
            <option value="">{channels === null ? 'Loading channels…' : 'Choose a channel'}</option>
            {options.map((ch) => (
              <option key={ch.id} value={ch.id}>{channelLabel(ch)}{ch.notFound ? ' (not found)' : ''}</option>
            ))}
          </select>
          {channelError && <p id="slack-auto-channel-error" className="text-xs text-destructive">{channelError}</p>}
          {channelsError && (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p id="slack-auto-channel-load-error" className="min-w-0 flex-1 basis-56 text-xs text-destructive">{channelsError}</p>
              <Button size="sm" variant="outline" onClick={reloadChannels} disabled={loadingChannels} focusableWhenDisabled>
                {loadingChannels ? 'Reloading…' : 'Reload channels'}
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Stays focusable when there is nothing to save, so a finished save
              never drops focus. */}
          <Button onClick={save} disabled={!!pending || !dirty} focusableWhenDisabled aria-label={`${pending === 'save' ? 'Saving' : 'Save'} auto-invite settings`}>
            {pending === 'save' ? 'Saving…' : 'Save'}
          </Button>
          {dirty && pending !== 'save' && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
        </div>
        {results.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Recent results</h4>
              {retryable > 0 && <Button size="sm" variant="outline" disabled={!!pending} focusableWhenDisabled onClick={() => retry({ all: true }, 'Retried')}>Retry everyone not added ({retryable})</Button>}
            </div>
            <ul
              id="slack-auto-invite-results"
              aria-label="Auto-invite results"
              className={cn('space-y-1 text-sm sm:max-h-60 sm:overflow-y-auto', !showAllResults && 'max-sm:[&>li:nth-child(n+11)]:hidden')}
            >
              {results.map((r) => (
                <li key={r.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 flex-1 basis-40 [overflow-wrap:anywhere]">{r.name} <span className="text-muted-foreground">{r.email}</span></span>
                  <span className={`min-w-0 [overflow-wrap:anywhere] ${r.status === 'invited' ? 'text-success-foreground' : r.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`} title={r.error || undefined}>
                    {r.inProgress ? 'In progress' : STATUS_TEXT[r.status] || r.status}{r.error ? ` (${r.error})` : ''}
                  </span>
                  {!r.inProgress && (r.status !== 'invited' || r.channelId !== settings?.autoInviteChannelId) && (
                    <Button size="xs" variant="ghost" disabled={!!pending} focusableWhenDisabled aria-label={`Retry ${r.name}`} onClick={() => retry({ userId: r.userId }, `Retried ${r.name}`)}>Retry</Button>
                  )}
                </li>
              ))}
            </ul>
            {results.length > RESULTS_PREVIEW && (
              <Button
                ref={resultsToggleRef}
                size="sm"
                variant="outline"
                className="sm:hidden"
                aria-expanded={showAllResults}
                aria-controls="slack-auto-invite-results"
                onClick={toggleResults}
              >
                {showAllResults ? `Show the ${RESULTS_PREVIEW} newest` : `Show all ${results.length} results`}
              </Button>
            )}
          </div>
        )}
      </div>
      <p
        className={cn('text-sm [&:not(:empty)]:mt-3', status?.type === 'error' ? 'text-destructive' : status?.type === 'success' ? 'text-success-foreground' : 'text-muted-foreground')}
        role="status"
        aria-live="polite"
      >
        {status?.text || ''}
      </p>
    </section>
  );
}
