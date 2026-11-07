import { useEffect, useState } from 'react';
import { authenticatedFetch, captureAuthSession, isAuthSessionCurrent, getSessionGeneration } from '../../js/auth.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { Button } from '@/components/ui/button';

/**
 * An invite to this account (#363): the learner joined the wait list while
 * already having an account, and an admin invited them. Accept merges the
 * wait-list answers into the account (only what it doesn't have yet); Decline
 * discards the invite. Shown on the lessons list, where the invite email links. Server: GET /v1/me/invite and
 * POST /v1/me/invite/:token/{accept,decline} (lib/account-invites.js).
 */
export default function AccountInviteNotice() {
  const { user } = useAuth();
  return <SessionInviteNotice key={`${user?.userId || ''}:${getSessionGeneration()}`} />;
}

function SessionInviteNotice() {
  const { user, refreshUser } = useAuth();
  const ownerId = user?.userId;
  const [invite, setInvite] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await captureAuthSession();
      if (session?.userId !== ownerId) return;
      const response = await authenticatedFetch('/v1/me/invite', { expectedUserId: ownerId });
      const data = response.ok ? await response.json() : null;
      if (!cancelled && await isAuthSessionCurrent(session) && session.generation === getSessionGeneration()) setInvite(data?.invite || null);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [ownerId]);

  async function respond(action) {
    const session = await captureAuthSession();
    if (session?.userId !== ownerId) return;
    setBusy(true);
    setError('');
    try {
      const res = await authenticatedFetch(`/v1/me/invite/${encodeURIComponent(invite.inviteToken)}/${action}`, { method: 'POST', expectedUserId: ownerId });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Something went wrong. Please try again.');
      if (!await isAuthSessionCurrent(session) || session.generation !== getSessionGeneration()) return;
      if (action === 'accept') {
        const { refreshCurrentUser } = await import('../../js/auth.js');
        await refreshCurrentUser();
        await refreshUser();
        if (!await isAuthSessionCurrent(session) || session.generation !== getSessionGeneration()) return;
      }
      setInvite(null);
      setStatus(action === 'accept' ? 'Invite accepted. Your details are updated.' : 'Invite declined.');
    } catch (e) {
      if (await isAuthSessionCurrent(session) && session.generation === getSessionGeneration()) setError(e.message);
    } finally {
      if (await isAuthSessionCurrent(session) && session.generation === getSessionGeneration()) setBusy(false);
    }
  }

  const adds = invite ? [invite.userGroup && `the group ${invite.userGroup}`, ...(invite.fields || [])].filter(Boolean) : [];

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
      {invite && (
        <section aria-labelledby="account-invite-title" className="mb-4">
          <div className="rounded-lg border bg-card p-4 text-card-foreground">
            <h2 id="account-invite-title" className="text-base font-semibold">You’re invited</h2>
            <p className="mt-1 text-sm">
              {invite.invitedByName ? `${invite.invitedByName} invited you` : 'You were invited'} with the details you gave when you joined the wait list.
              {adds.length > 0 ? ` Accepting adds ${adds.join(', ')} to your account.` : ' Your account already has them, so nothing changes.'}
            </p>
            {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => respond('accept')} disabled={busy}>Accept</Button>
              <Button size="sm" variant="outline" onClick={() => respond('decline')} disabled={busy}>Decline</Button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
