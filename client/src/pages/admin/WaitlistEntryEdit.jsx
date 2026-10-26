import { useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { adminApi } from './adminApi.js';
import CustomFieldInput from '../../components/CustomFieldInput.jsx';
import { missingRequired } from '../../lib/userFields.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import UsersFeedback from './UsersFeedback.jsx';

/**
 * Admin → Users → a wait-list row (#363): edit the person's name, email,
 * group, and custom field answers before inviting them. Deep-linked at
 * /plato/users/waitlist/:token, same shape as the Edit User view.
 */
export default function WaitlistEntryEdit({ entry, groups, userFields, onBack, onSaved, onInvite, onRemove, isMobile = false }) {
  const [form, setForm] = useState({
    name: entry.name || '',
    email: entry.email || '',
    userGroup: entry.userGroup || '',
    customFields: { ...(entry.customFields || {}) },
  });
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const busyRef = useRef(false);

  // Invite emails the saved entry, so it waits until edits are saved rather
  // than silently sending the old answers (or the old address).
  const dirty = form.name !== (entry.name || '')
    || form.email !== (entry.email || '')
    || form.userGroup !== (entry.userGroup || '')
    || userFields.some((f) => (form.customFields[f.id] ?? '') !== (entry.customFields?.[f.id] ?? ''));

  async function save() {
    if (busyRef.current) return;
    const missing = missingRequired(userFields, form.customFields);
    if (missing.length) {
      const labels = userFields.filter(f => missing.includes(f.id)).map(f => f.label);
      setMessage({ text: `Fill in required ${labels.length === 1 ? 'field' : 'fields'}: ${labels.join(', ')}.`, type: 'error' });
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      await adminApi('PUT', `/v1/admin/waitlist/${entry.inviteToken}`, {
        name: form.name,
        email: form.email,
        userGroup: form.userGroup || null,
        // Send every defined field so cleared inputs clear the stored answer.
        customFields: Object.fromEntries(userFields.map((f) => [f.id, form.customFields[f.id] ?? ''])),
      });
      onSaved(`Saved ${form.email.trim().toLowerCase()}.`);
    } catch (e) {
      setMessage({ text: e.message, type: 'error' });
    }
    finally { busyRef.current = false; setSaving(false); }
  }

  async function invite() {
    if (busyRef.current || dirty) return;
    busyRef.current = true;
    setInviting(true);
    setMessage(null);
    try {
      if (!await onInvite(entry)) setMessage({ type: 'error', text: 'The invite could not be sent. Your answers are saved. Try again.' });
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'The invite could not be sent. Try again.' });
    } finally { busyRef.current = false; setInviting(false); }
  }

  const actions = <div className={isMobile ? 'users-mobile-actions admin-sticky-bar space-y-3' : 'space-y-3 pt-2'}>
    {isMobile && message && <UsersFeedback message={message} />}
    {dirty && <p id="wl-edit-invite-hint" className="text-sm text-muted-foreground">Save your changes before inviting. The invite uses the saved answers.</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={save} disabled={saving || inviting} focusableWhenDisabled className="flex-1 md:flex-none">
        {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}{saving ? 'Saving…' : 'Save'}
      </Button>
      <Button variant="outline" onClick={onBack} disabled={saving || inviting} focusableWhenDisabled>Cancel</Button>
      <Button variant="outline" onClick={invite} disabled={saving || dirty || inviting} focusableWhenDisabled aria-describedby={dirty ? 'wl-edit-invite-hint' : undefined}>
        {inviting && <LoaderCircle aria-hidden="true" className="animate-spin" />}{inviting ? 'Sending…' : 'Invite'}
      </Button>
    </div>
    <span role="status" className="sr-only">{saving ? 'Saving entry…' : inviting ? 'Sending invite…' : ''}</span>
  </div>;

  return (
    <div className="users-page users-editor">
      <div className="flex items-center gap-3 mb-4">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={saving || inviting} focusableWhenDisabled aria-label="Back to users">&larr; Back</Button>
        <h1 tabIndex={-1} className="text-2xl font-bold outline-none">Edit Wait List Entry</h1>
      </div>
      {!isMobile && message && (
        <div className={`rounded-lg border px-4 py-3 mb-4 text-sm ${message.type === 'error' ? 'border-danger-border bg-danger text-danger-foreground' : 'border-success-border bg-success text-success-foreground'}`} role="alert">
          {message.text}
        </div>
      )}
      <Card>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Joined {new Date(entry.createdAt).toLocaleDateString()}. Invite sends the signup email, prefilled with these answers.
          </p>
          <div className="space-y-2">
            <Label htmlFor="wl-edit-name">Name</Label>
            <Input id="wl-edit-name" type="text" autoComplete="name" enterKeyHint="next" readOnly={saving || inviting} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wl-edit-email">Email</Label>
            <Input id="wl-edit-email" type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="email" enterKeyHint="done" readOnly={saving || inviting} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wl-edit-group">User Group</Label>
            <select id="wl-edit-group" value={form.userGroup} aria-readonly={saving || inviting || undefined}
              onChange={e => { if (!saving && !inviting) setForm({ ...form, userGroup: e.target.value }); }}
              className="h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base md:text-sm">
              <option value="">None</option>
              {/* Keep a group that's since been renamed/deleted visible rather than silently blanking it. */}
              {form.userGroup && !groups.includes(form.userGroup) && <option value={form.userGroup}>{form.userGroup} (no longer a group)</option>}
              {groups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          {userFields.map(f => (
            <CustomFieldInput
              key={f.id}
              field={f}
              idPrefix="wl-edit-field"
              value={form.customFields[f.id]}
              onChange={(v) => setForm(prev => ({ ...prev, customFields: { ...prev.customFields, [f.id]: v } }))}
              readOnly={saving || inviting}
            />
          ))}
          {!isMobile && actions}
          <div className="border-t pt-4"><Button variant="destructive" onClick={() => onRemove(entry, e => setMessage({ text: e.message || 'The entry could not be removed. Try again.', type: 'error' }))} disabled={saving || inviting} focusableWhenDisabled>Remove from wait list</Button></div>
        </CardContent>
      </Card>
      {isMobile && actions}
    </div>
  );
}
