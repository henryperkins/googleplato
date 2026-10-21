import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import ConfirmModal from '@/components/modals/ConfirmModal';

export default function CloudflareConnection({ settings, pending, busy, connectRef, onConnect, onSelectAccount, onDisconnect, onRevoke }) {
  const oauth = settings.workersAiOAuth || {};
  const credentials = settings.workersAiCredentials;
  const [selectedAccount, setSelectedAccount] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const hasConnection = oauth.connected || oauth.needsReconnect || oauth.connectionPending;
  const environmentAccess = credentials.source === 'environment' || (!hasConnection && credentials.configured);

  return (
    <div id="workers-credentials-help" className="rounded-md bg-muted p-3 text-sm space-y-3">
      <div className="space-y-1">
        <h3 className="font-semibold">Cloudflare connection</h3>
        {oauth.connected ? <>
          <p>Connected to <strong>{oauth.account?.name || 'Cloudflare'}</strong>.</p>
          <p className="text-muted-foreground">This account is shared by the classroom’s AI requests. Test the selected model to check access.</p>
        </> : oauth.connectionPending ? <p>A Cloudflare connection is finishing. You can disconnect it if it does not complete.</p>
          : oauth.needsReconnect ? <p>Cloudflare needs to be reconnected before new Workers AI requests can run.</p>
          : environmentAccess ? <p>Workers AI credentials are configured on the server. You can also connect an account through your browser.</p>
          : <p>Connect your Cloudflare account to use Workers AI. You’ll sign in on Cloudflare and choose the account Plato can access.</p>}
      </div>

      {oauth.pendingAccounts?.length > 0 ? (
        <div className="space-y-2">
          <Label htmlFor="cloudflare-account">Account for this classroom</Label>
          <select
            id="cloudflare-account"
            value={selectedAccount}
            onChange={event => setSelectedAccount(event.target.value)}
            className="touch-target w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm"
            aria-describedby="cloudflare-account-help"
          >
            <option value="">Choose an account</option>
            {oauth.pendingAccounts.map(account => <option key={account.id} value={account.id}>{account.name} ({account.id.slice(0, 8)}…)</option>)}
          </select>
          <p id="cloudflare-account-help" className="text-muted-foreground">Cloudflare authorized more than one account. Choose which account will handle the classroom’s Workers AI usage.</p>
          <Button type="button" onClick={() => onSelectAccount(selectedAccount)} disabled={pending || !selectedAccount} focusableWhenDisabled>
            {busy === 'account' ? 'Connecting account…' : 'Use this account'}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 [&>button]:h-auto [&>button]:min-h-10 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:py-2">
        <Button ref={connectRef} type="button" variant={oauth.connected ? 'outline' : 'default'} onClick={onConnect} disabled={pending || !oauth.available} aria-describedby={!oauth.available ? 'cloudflare-oauth-setup' : undefined} focusableWhenDisabled>
          {busy === 'connect' ? 'Opening Cloudflare…' : hasConnection ? 'Reconnect Cloudflare' : 'Connect Cloudflare'}
        </Button>
        {hasConnection ? <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirmDisconnect(true)} focusableWhenDisabled>Disconnect Cloudflare</Button> : null}
      </div>

      {!oauth.available ? <p id="cloudflare-oauth-setup" className="text-muted-foreground">Browser connection requires a one-time server setup. Ask the server owner to register Plato as a Cloudflare OAuth application.</p> : null}

      {oauth.revocationPending ? <div className="space-y-2">
        <p>{oauth.connected ? 'Previous Cloudflare access still needs to be revoked. Your current classroom connection is kept.' : 'Cloudflare access still needs to be revoked for a previous connection.'}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={onRevoke} disabled={pending} focusableWhenDisabled>Retry revoking access</Button>
          <a className="touch-target-inline underline underline-offset-4" href="https://dash.cloudflare.com/?to=/profile/access-management/authorization" target="_blank" rel="noopener noreferrer">Manage Cloudflare authorizations</a>
        </div>
      </div> : null}

      {!hasConnection ? (
        <details>
          <summary className="touch-target-inline w-fit max-w-full cursor-pointer underline underline-offset-4">Manual server configuration</summary>
          <div className="mt-2 space-y-2">
            <p>Account ID: {credentials.accountId ? 'present' : 'missing or invalid'}. API token: {credentials.apiToken ? 'present' : 'missing'}.</p>
            <p>Set <code>CLOUDFLARE_ACCOUNT_ID</code> and <code>CLOUDFLARE_API_TOKEN</code> on the server, then restart and reload settings. The token needs Workers AI Read and Edit permissions.</p>
            <a className="touch-target-inline inline-block max-w-full underline underline-offset-4" href="https://developers.cloudflare.com/workers-ai/get-started/rest-api/" target="_blank" rel="noopener noreferrer">Cloudflare token setup guide</a>
          </div>
        </details>
      ) : null}

      <ConfirmModal
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Cloudflare?"
        message="This removes the browser connection for the entire classroom. New Workers AI requests will need another connection or credentials configured on the server. The selected AI provider and model stay saved."
        confirmLabel="Disconnect Cloudflare"
        onConfirm={onDisconnect}
      />
    </div>
  );
}
