import { useState } from 'react';
import { adminApi } from './adminApi.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import ConfirmModal from '../../components/modals/ConfirmModal.jsx';

/**
 * Admin → Users → "Wait List" (#363): open or close the public form, and
 * make or revoke the API key an outside form uses. A new key is shown once.
 * When the current settings couldn't be loaded, the controls stay hidden:
 * "Make a key" would otherwise skip its confirmation and replace a live key.
 */
export default function WaitlistDialog({ open, onOpenChange, settings, onChange, loadFailed = false, onRetry }) {
  const [newKey, setNewKey] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmState, setConfirmState] = useState(null);

  async function run(fn) {
    setSaving(true);
    setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  const toggleOpen = (next) => run(async () => {
    await adminApi('PUT', '/v1/admin/waitlist/settings', { open: next });
    onChange({ ...settings, open: next });
  });

  const performMakeKey = () => run(async () => {
    const { apiKey } = await adminApi('POST', '/v1/admin/waitlist/key');
    setNewKey(apiKey);
    setCopied(false);
    onChange({ ...settings, hasApiKey: true });
  });

  const makeKey = () => {
    if (settings.hasApiKey) {
      setConfirmState({
        title: 'Make a new API key?',
        message: 'The old key will immediately stop working.',
        confirmLabel: 'Make new key',
        onConfirm: performMakeKey,
      });
      return;
    }
    performMakeKey();
  };

  const revokeKey = () => {
    setConfirmState({
      title: 'Revoke API key?',
      message: 'Outside forms using this key will stop working.',
      confirmLabel: 'Revoke key',
      onConfirm: () => run(async () => {
        await adminApi('DELETE', '/v1/admin/waitlist/key');
        setNewKey('');
        onChange({ ...settings, hasApiKey: false });
      }),
    });
  };

  async function copyKey() {
    try { await navigator.clipboard.writeText(newKey); setCopied(true); } catch { /* ignore */ }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) { setNewKey(''); setError(''); } onOpenChange(v); }}>
        <DialogContent variant="sheet">
          <DialogHeader>
            <DialogTitle>Wait List</DialogTitle>
            <DialogDescription>
              People on the wait list show under the Wait List filter. Invite them from there.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {loadFailed ? (
            <div className="space-y-3">
              <p className="text-sm text-destructive" role="alert">
                The wait-list settings couldn&apos;t be loaded, so they can&apos;t be changed yet.
              </p>
              <Button variant="outline" onClick={onRetry}>Try again</Button>
            </div>
          ) : (
          <>
          <div className="flex items-center gap-2.5">
            <input
              id="waitlist-open"
              type="checkbox"
              className="h-4 w-4 shrink-0 rounded border-input"
              checked={!!settings.open}
              disabled={saving}
              onChange={(e) => toggleOpen(e.target.checked)}
            />
            <Label htmlFor="waitlist-open" className="touch-target flex items-center cursor-pointer select-none leading-snug">
              Show &quot;Join the wait list&quot; on the sign-in page
            </Label>
          </div>
          <div className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-semibold">API key</h3>
            <p className="text-sm text-muted-foreground">
              An outside form can add people by sending <code>POST /v1/waitlist</code> with the header{' '}
              <code className="break-words">Authorization: Bearer &lt;key&gt;</code>. This works even when the wait list is closed.
              Send it from a server, not from a web page, so the key stays private.{' '}
              <a href="https://github.com/1111philo/plato/blob/main/docs/WAITLIST_API.md" target="_blank" rel="noopener noreferrer" className="underline">
                API guide<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
            {newKey && (
              <div className="space-y-1">
                <Label htmlFor="waitlist-new-key">New key (shown once)</Label>
                <div className="flex gap-2">
                  <Input id="waitlist-new-key" readOnly value={newKey} onFocus={(e) => e.target.select()} />
                  <Button variant="outline" onClick={copyKey}>{copied ? 'Copied' : 'Copy'}</Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={makeKey} disabled={saving}>
                {settings.hasApiKey ? 'Make a new key' : 'Make a key'}
              </Button>
              {settings.hasApiKey && (
                <Button variant="destructive" onClick={revokeKey} disabled={saving}>Revoke key</Button>
              )}
            </div>
          </div>
          </>
          )}
        </DialogContent>
      </Dialog>

      {confirmState && (
        <ConfirmModal
          open={!!confirmState}
          onOpenChange={(o) => { if (!o) setConfirmState(null); }}
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          onConfirm={() => {
            const fn = confirmState.onConfirm;
            setConfirmState(null);
            fn?.();
          }}
        />
      )}
    </>
  );
}
