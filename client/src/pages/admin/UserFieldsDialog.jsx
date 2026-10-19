import { useState } from 'react';
import { adminApi } from './adminApi.js';
import { FIELD_TYPE_OPTIONS, fieldTypeLabel } from '../../lib/userFields.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import ConfirmModal from '../../components/modals/ConfirmModal.jsx';

const SELECT_CLASS = 'h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm';
const EMPTY_FORM = { label: '', type: 'text', required: false, options: '' };

/**
 * Admin → Users → "User Fields": manage admin-defined custom user fields
 * (#364). Can be rendered inside a Dialog or inline on a dedicated route.
 * Changing a type is allowed; if stored answers wouldn't pass the new rules,
 * the server replies 409 with a count and we confirm via ConfirmModal first.
 */
export function UserFieldsEditor({ fields, onChange }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmState, setConfirmState] = useState(null);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setError('');
  }

  function startEdit(f) {
    setEditingId(f.id);
    setForm({ label: f.label, type: f.type, required: !!f.required, options: (f.options || []).join('\n') });
    setError('');
  }

  async function run(fn) {
    setSaving(true);
    setError('');
    try {
      const data = await fn();
      onChange(data.userFields || []);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const body = {
      label: form.label,
      type: form.type,
      required: form.required,
      options: form.type === 'dropdown' ? form.options.split('\n') : undefined,
    };
    if (!editingId) {
      const ok = await run(() => adminApi('POST', '/v1/admin/user-fields', body));
      if (ok) resetForm();
      return;
    }
    const path = `/v1/admin/user-fields/${editingId}`;
    setSaving(true);
    setError('');
    try {
      const data = await adminApi('PUT', path, body);
      onChange(data.userFields || []);
      resetForm();
    } catch (err) {
      if (err.status === 409 && err.data?.invalidCount) {
        const n = err.data.invalidCount;
        setConfirmState({
          title: 'Save field changes?',
          message: `${n} existing ${n === 1 ? "answer doesn't" : "answers don't"} fit the new rules. They'll be kept, but must be fixed the next time they're edited.`,
          confirmLabel: 'Save anyway',
          onConfirm: async () => {
            const ok = await run(() => adminApi('PUT', path, { ...body, confirmInvalid: true }));
            if (ok) resetForm();
          },
        });
      } else {
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  function handleDelete(f) {
    setConfirmState({
      title: `Delete "${f.label}" field?`,
      message: "Every user's answer to this field will be erased. This cannot be undone.",
      confirmLabel: 'Delete field',
      onConfirm: async () => {
        const ok = await run(() => adminApi('DELETE', `/v1/admin/user-fields/${f.id}`));
        if (ok && editingId === f.id) resetForm();
      },
    });
  }

  function handleMove(idx, delta) {
    const ids = fields.map((f) => f.id);
    const [moved] = ids.splice(idx, 1);
    ids.splice(idx + delta, 0, moved);
    run(() => adminApi('PUT', '/v1/admin/user-fields/order', { ids }));
  }

  return (
    <>
      <div className="space-y-4">
        {fields.length > 0 ? (
          <ul className="max-h-[min(14rem,35dvh)] overflow-y-auto overscroll-contain space-y-1 pr-1" aria-label="Custom user fields">
            {fields.map((f, idx) => (
              <li key={f.id} className="flex items-center gap-2 rounded-md px-3 py-2 bg-muted/50">
                <span className="text-sm flex-1 min-w-0 truncate">{f.label}</span>
                <Badge variant="outline">{fieldTypeLabel(f.type)}</Badge>
                {f.required && <Badge variant="secondary">Required</Badge>}
                <Button variant="ghost" size="icon-xs" title="Move up" aria-label={`Move ${f.label} up`} disabled={saving || idx === 0} onClick={() => handleMove(idx, -1)}>&uarr;</Button>
                <Button variant="ghost" size="icon-xs" title="Move down" aria-label={`Move ${f.label} down`} disabled={saving || idx === fields.length - 1} onClick={() => handleMove(idx, 1)}>&darr;</Button>
                <Button variant="ghost" size="icon-xs" title="Edit" aria-label={`Edit field ${f.label}`} aria-pressed={editingId === f.id} disabled={saving} onClick={() => startEdit(f)}>&#9998;</Button>
                <Button variant="ghost" size="icon-xs" title="Delete" aria-label={`Delete field ${f.label}`} disabled={saving} onClick={() => handleDelete(f)}>&#10005;</Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No custom fields yet.</p>
        )}

        <form className="space-y-3 rounded-lg border p-3" onSubmit={handleSubmit} aria-labelledby="user-field-form-heading">
          <h3 id="user-field-form-heading" className="text-sm font-semibold">{editingId ? 'Edit field' : 'Add a field'}</h3>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <div className="space-y-1.5">
            <Label htmlFor="user-field-label">Label</Label>
            <Input id="user-field-label" value={form.label} maxLength={80}
              onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-field-type">Type</Label>
            <select id="user-field-type" className={SELECT_CLASS} value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {FIELD_TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {form.type === 'dropdown' && (
            <div className="space-y-1.5">
              <Label htmlFor="user-field-options">Options <span className="text-muted-foreground text-xs">(one per line)</span></Label>
              <Textarea id="user-field-options" rows={4} value={form.options}
                onChange={(e) => setForm({ ...form, options: e.target.value })} />
            </div>
          )}
          <div className="flex items-center gap-2">
            <input id="user-field-required" type="checkbox" className="h-4 w-4" checked={form.required}
              onChange={(e) => setForm({ ...form, required: e.target.checked })} />
            <Label htmlFor="user-field-required">Required</Label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={saving || !form.label.trim()}>{editingId ? 'Save field' : 'Add field'}</Button>
            {editingId && <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>}
          </div>
        </form>
      </div>

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

export default function UserFieldsDialog({ open, onOpenChange, fields, onChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="sheet" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>User Fields</DialogTitle>
          <DialogDescription>
            Extra profile fields users fill in at signup and in their settings. Required fields must be completed before a user can continue to their lessons.
          </DialogDescription>
        </DialogHeader>
        <UserFieldsEditor fields={fields} onChange={onChange} />
      </DialogContent>
    </Dialog>
  );
}
