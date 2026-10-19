import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { getMyFields, updateProfile } from '../../js/auth.js';
import { pickValues, validateCustomField, validateCustomFields } from '../lib/userFields.js';
import CustomFieldInput from './CustomFieldInput.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Blocks the classroom until the learner has filled every required custom
 * user field (#364). Status is fetched fresh on mount (each classroom load),
 * so a field an admin marks required catches learners on their next visit.
 *
 * Fails open: if the status request errors, the classroom renders — a
 * profile prompt must never lock learners out of their lessons. Skipped
 * during admin "View as User" (the read-only audit view isn't the admin's
 * own profile). Admin pages (/plato/*) are outside this gate.
 */
const GATE_DRAFT_KEY = 'plato_profile_gate_draft';

export default function ProfileCompletionGate({ children }) {
  const { impersonatedUser } = useAuth();
  const [status, setStatus] = useState(null); // { userFields, values, missing } | 'ok'
  const [values, setValues] = useState(() => {
    try {
      const raw = sessionStorage.getItem(GATE_DRAFT_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const headingRef = useRef(null);

  useEffect(() => {
    if (impersonatedUser) return;
    let cancelled = false;
    getMyFields()
      .then((data) => {
        if (cancelled) return;
        if (!data.missing?.length) { setStatus('ok'); return; }
        let draft = {};
        try {
          const raw = sessionStorage.getItem(GATE_DRAFT_KEY);
          if (raw) draft = JSON.parse(raw);
        } catch { /* ignore */ }
        setValues({ ...(data.values || {}), ...draft });
        setStatus(data);
      })
      .catch(() => { if (!cancelled) setStatus('ok'); });
    return () => { cancelled = true; };
  }, [impersonatedUser]);

  const blocking = status && status !== 'ok';
  useEffect(() => {
    if (blocking) headingRef.current?.focus();
  }, [blocking]);

  useEffect(() => {
    if (!blocking) return;
    try {
      sessionStorage.setItem(GATE_DRAFT_KEY, JSON.stringify(values));
    } catch { /* ignore */ }
  }, [blocking, values]);

  if (impersonatedUser || status === 'ok') return children;
  if (status === null) {
    return (
      <div className="flex items-center justify-center py-12" role="status" aria-live="polite">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" aria-hidden="true" />
        <span className="sr-only">Loading...</span>
      </div>
    );
  }

  // Show the fields that were missing when the gate opened (stable while typing).
  const fields = status.userFields.filter((f) => status.missing.includes(f.id));

  async function handleSubmit(e) {
    e.preventDefault();
    const cfErrs = validateCustomFields(fields, values);
    const cfIds = Object.keys(cfErrs);
    if (cfIds.length) {
      setFieldErrors(cfErrs);
      document.getElementById(`gate-${cfIds[0]}`)?.focus();
      return;
    }
    setFieldErrors({});
    setSaving(true);
    setError('');
    try {
      await updateProfile({ customFields: pickValues(values, fields.map((f) => f.id)) });
      const fresh = await getMyFields();
      if (fresh.missing?.length) {
        setValues(fresh.values || {});
        setStatus(fresh);
      } else {
        try { sessionStorage.removeItem(GATE_DRAFT_KEY); } catch { /* ignore */ }
        setStatus('ok');
      }
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg p-4">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 ref={headingRef} tabIndex={-1} className="outline-none">Update your profile</h2>
          </CardTitle>
          <CardDescription>
            We&apos;ve added {fields.length === 1 ? 'a required field' : 'required fields'} you&apos;ll need to enter before you continue:
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            {error && (
              <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-lg p-3 text-sm" role="alert">
                {error}
              </div>
            )}
            {fields.map((f, idx) => (
              <CustomFieldInput
                key={f.id}
                field={f}
                idPrefix="gate"
                enterKeyHint={idx === fields.length - 1 ? 'done' : 'next'}
                value={values[f.id]}
                error={fieldErrors[f.id]}
                onChange={(v) => {
                  setValues((prev) => ({ ...prev, [f.id]: v }));
                  if (fieldErrors[f.id]) setFieldErrors((prev) => ({ ...prev, [f.id]: '' }));
                }}
                onBlur={() => {
                  if (f.required || values[f.id] || fieldErrors[f.id]) {
                    if (f.required && !values[f.id] && !fieldErrors[f.id] && values[f.id] === undefined) return;
                    const err = validateCustomField(f, values[f.id]);
                    setFieldErrors((prev) => ({ ...prev, [f.id]: err }));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    const nextField = fields[idx + 1];
                    if (nextField) {
                      document.getElementById(`gate-${nextField.id}`)?.focus();
                    } else {
                      handleSubmit(e);
                    }
                  }
                }}
                disabled={saving}
              />
            ))}
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Continue'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
