import { roleLabel } from '../../lib/permissions.js';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PluginSlot } from '@/lib/plugins/Slot.jsx';

export function UserCompletion({ user, compact = false }) {
  const { lessonsCompleted: completed, lessonsAvailable: available } = user;
  if (typeof completed !== 'number' || typeof available !== 'number') {
    return <span className="text-muted-foreground">No activity data</span>;
  }
  if (available <= 0) return <span className="text-muted-foreground">No published lessons</span>;
  return (
    <span className="tabular-nums" title="Completed lessons out of all published lessons">
      <span className="font-medium">{completed}</span> of {available}
      <span className={compact ? 'sr-only' : ''}> lessons completed</span>
    </span>
  );
}

function Detail({ label, children }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

// The directory owns filtering, sorting, pagination and mutations. This is
// only the narrow-screen presentation, so every action uses the same guards.
export default function UserMobileList({
  items, currentUserId, filterField, slackConnected, pendingRows,
  onEdit, onEditWaitlist, onInvite, onResend, onRevoke, onRemove, onDelete, permissions,
}) {
  return (
    <ul aria-label="Users and invites" className="divide-y divide-border border-y border-border">
      {items.map(item => {
        const name = item.name || item.email;
        const status = item._type === 'waitlist' ? 'Wait List'
          : item._type === 'invite' ? 'Invited' : roleLabel(item.role);
        // Any running action holds the whole row; only its own control says so.
        const pendingAction = pendingRows[item._key];
        const pending = !!pendingAction;
        const primaryAction = item._type === 'waitlist' ? 'invite' : 'resend';
        const primaryRunning = pendingAction === primaryAction;
        return (
          <li key={item._key} className="py-3" data-user-key={item._key}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {item._type === 'invite' ? (
                  <p className="font-medium wrap-anywhere">{name}</p>
                ) : (
                  <button
                    type="button"
                    className="touch-target block w-full rounded-sm text-left font-medium wrap-anywhere hover:text-link"
                    aria-label={item._type === 'waitlist' ? `Edit wait list entry for ${name}` : `Edit ${name}`}
                    onClick={() => item._type === 'waitlist' ? onEditWaitlist(item) : onEdit(item._user)}
                  >
                    <span className="block underline underline-offset-4">{name}</span>
                  </button>
                )}
                {/* Outside the button: its accessible name must contain all of
                    its visible text (WCAG 2.5.3), and "Edit <name>" doesn't. */}
                {item._type !== 'invite' && item.name && <p className="text-sm text-muted-foreground wrap-anywhere">{item.email}</p>}
              </div>
              <Badge variant={item.role === 'admin' ? 'default' : 'outline'} className="mt-2 shrink-0">{status}</Badge>
            </div>
            {item._type === 'user' ? (
              <p className="mt-1 text-sm text-muted-foreground"><UserCompletion user={item._user} /></p>
            ) : item._type === 'waitlist' ? (
              <p className="mt-2 text-sm text-muted-foreground">Joined <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>{item._entry?.alreadyRegistered && <> &middot; {item._entry.alreadyRegistered === 'account' ? 'Has an account' : 'Invited'}</>}</p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">Waiting to sign up</p>
            )}
            <div className="mt-1 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <details className="users-row-details min-w-0 flex-1 basis-36">
                <summary className="touch-target flex min-h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-sm text-sm font-medium hover:text-link [&::-webkit-details-marker]:hidden">
                  Details <span className="sr-only">for {name}</span>
                  <ChevronDown aria-hidden="true" className="users-detail-chevron size-4" />
                </summary>
                <div className="pb-1 pt-2">
                  <dl className="space-y-3 text-sm">
                    {item._user?.userId && <Detail label="User ID"><span className="font-mono text-xs select-all">{item._user.userId}</span></Detail>}
                    {item.username && <Detail label="Username">@{item.username}</Detail>}
                    <Detail label="Group">{item.userGroup || 'No group'}</Detail>
                    {item._type === 'user' && <Detail label="Last active">{item._user.lastActiveAt ? new Date(item._user.lastActiveAt).toLocaleDateString() : 'Never'}</Detail>}
                    {item._type === 'user' && <Detail label="Lesson scope">All published lessons.</Detail>}
                    {item._type !== 'waitlist' && <Detail label="Date added">{new Date(item.createdAt).toLocaleDateString()}</Detail>}
                    {filterField && <Detail label={filterField.label}>{item.customFields?.[filterField.id] || 'Not provided'}</Detail>}
                    {slackConnected && <Detail label="Slack">{item._user?.slackUserId ? 'Linked' : 'Not linked'}</Detail>}
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item._type === 'user' && permissions.users && <PluginSlot name="adminUserRowAction" context={{ user: item._user }} />}
                    {item._type === 'user' && permissions.users && item._key !== currentUserId && (
                      <Button variant="destructive" onClick={() => onDelete(item._key, name)} aria-label={`Delete ${name}`}>Delete user</Button>
                    )}
                    {item._type === 'waitlist' && permissions.remove && (
                      <Button variant="destructive" disabled={pending} focusableWhenDisabled onClick={() => onRemove(item._key, item.email)} aria-label={`Remove ${item.email} from the wait list`}>
                        {pendingAction === 'remove' && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                        {pendingAction === 'remove' ? 'Removing…' : 'Remove'}
                      </Button>
                    )}
                    {item._type === 'invite' && permissions.invites && (
                      <Button variant="destructive" disabled={pending} focusableWhenDisabled onClick={() => onRevoke(item._invite.inviteToken, item.email)} aria-label={`Revoke invite for ${item.email}`}>Revoke invite</Button>
                    )}
                  </div>
                </div>
              </details>
              {((item._type === 'waitlist' && permissions.invite && item._entry?.alreadyRegistered !== 'invite') || (item._type === 'invite' && permissions.invites)) && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={pending}
                  focusableWhenDisabled
                  aria-label={item._type === 'waitlist' ? `Invite ${item.email}` : `Resend invite to ${item.email}`}
                  onClick={() => item._type === 'waitlist' ? onInvite(item._key, item.email) : onResend(item.email, item._key)}
                >
                  {primaryRunning && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                  {primaryRunning ? 'Sending…' : item._type === 'waitlist' ? 'Invite' : 'Resend'}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
