import { beginAuthAttempt } from '../../js/authCoordination.js';
import NameFields from '../components/NameFields.jsx';
import { formNameParts } from '../../../server/src/shared/names.js';
import { useState, useEffect, useRef } from 'react';
import PasswordField from '../components/PasswordField.jsx';
import PublicAuthProviders from '../lib/plugins/PublicAuthProviders.jsx';
import { useAuth, usePublicAuthSurface } from '../contexts/AuthContext.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import { adoptAuthSession } from '../../js/auth.js';
import { missingFieldsMessage, requestError } from '../lib/authErrors.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { MAX_CLASSROOM_NAME } from '../lib/logoUpload.js';

const SETUP_DRAFT_KEY = 'plato_setup_draft';

export default function Setup() {
  usePublicAuthSurface();
  const { adoptExternalSession } = useAuth();
  const [savedDraft] = useState(() => {
    try {
      const raw = sessionStorage.getItem(SETUP_DRAFT_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [classroomName, setClassroomName] = useState(savedDraft.classroomName || '');
  const [email, setEmail] = useState(savedDraft.email || '');
  // A draft saved before first/last names (#402) has only `name`: split it.
  const [firstName, setFirstName] = useState(() => formNameParts(savedDraft).firstName);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [providerSubmitting, setProviderSubmitting] = useState(false);
  const firstNameRef = useRef(null);
  const lastNameRef = useRef(null);
  const [lastName, setLastName] = useState(() => formNameParts(savedDraft).lastName);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    document.title = 'Setup — plato';
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(SETUP_DRAFT_KEY, JSON.stringify({ classroomName, email, firstName, lastName }));
    } catch { /* ignore */ }
  }, [classroomName, email, firstName, lastName]);

  async function handleProviderSession(session, provider, attemptId) {
    await adoptExternalSession(session, provider, attemptId);
    try { sessionStorage.removeItem(SETUP_DRAFT_KEY); } catch { /* ignore */ }
    window.location.href = '/plato';
  }

  function validateEmail(val) {
    const trimmed = val.trim();
    if (!trimmed) return 'Email is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'Please enter a valid email address.';
    return '';
  }

  async function handleSetup(e) {
    if (e) e.preventDefault();
    if (submitting || providerSubmitting) return;
    const nextErrs = {};
    if (!firstName.trim()) nextErrs.firstName = 'First name is required.';
    const emailErr = validateEmail(email);
    if (emailErr) nextErrs.email = emailErr;
    if (!password) nextErrs.password = 'Password is required.';
    else if (password.length < 8) nextErrs.password = 'Password must be at least 8 characters.';
    if (password && password.length >= 8 && password !== confirm) {
      nextErrs.confirm = 'Passwords do not match.';
    }

    if (Object.keys(nextErrs).length > 0) {
      setFieldErrors(nextErrs);
      // The classroom name is optional, so name only the fields that are missing.
      const missing = [!firstName.trim() && 'your first name', !email.trim() && 'your email', !password && 'a password'].filter(Boolean);
      if (missing.length) {
        setError(missingFieldsMessage(missing));
      } else if (nextErrs.email) {
        setError(nextErrs.email);
      } else if (nextErrs.password) {
        setError(nextErrs.password);
      } else if (nextErrs.confirm) {
        setError(nextErrs.confirm);
      }
      if (nextErrs.firstName) firstNameRef.current?.focus();
      else if (nextErrs.email) emailRef.current?.focus();
      else if (nextErrs.password) passwordRef.current?.focus();
      else if (nextErrs.confirm) confirmRef.current?.focus();
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    setError('');
    try {
      const attemptId = await beginAuthAttempt();
      const res = await fetch('/v1/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), lastName: lastName.trim(), firstName: firstName.trim(), password, classroomName: classroomName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "We couldn't finish setup. Try again.");
      try { sessionStorage.removeItem(SETUP_DRAFT_KEY); } catch { /* ignore */ }
      // One guarded write, like every other new session (js/auth.js).
      await adoptAuthSession(data, 'password', attemptId);
      window.location.href = '/plato';
    } catch (e) {
      setError(requestError(e, "We couldn't finish setup. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh shrink-0 flex flex-col items-center justify-start py-12 p-4 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] bg-header text-header-foreground">
      <img src="/assets/logo-white.svg" alt="plato" width="160" height="40" fetchPriority="high" className="h-10 w-auto mb-6" />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle as="h1" className="text-2xl">Build your classroom</CardTitle>
          <CardDescription>Name your classroom and create your admin account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-lg p-3 text-sm" role="alert">
              {error}
            </div>
          )}
          <form className="space-y-4" onSubmit={handleSetup} noValidate>
            <div className="space-y-2">
              <Label htmlFor="setup-classroom">Classroom Name</Label>
              <Input
                id="setup-classroom"
                type="text"
                enterKeyHint="next"
                placeholder="e.g. AI Leaders Academy"
                autoComplete="organization"
                maxLength={MAX_CLASSROOM_NAME}
                aria-describedby="setup-classroom-hint"
                value={classroomName}
                onChange={e => setClassroomName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); firstNameRef.current?.focus(); } }}
              />
              <p id="setup-classroom-hint" className="text-xs text-muted-foreground">This appears in the header and on login pages. Up to 100 characters; you can change it later.</p>
            </div>
            <hr className="border-border" />
            <PublicAuthProviders
              surface="setup"
              dividerText="or set up with password"
              context={{
                options: {
                  classroomName: classroomName.trim() || undefined,
                  lastName: lastName.trim(),
                  firstName: firstName.trim() || undefined,
                },
                busy: submitting || providerSubmitting,
                setBusy: setProviderSubmitting,
                onSession: handleProviderSession,
                onError: setError,
              }}
            />
            <NameFields idPrefix="setup" value={{ firstName, lastName }} firstNameRef={firstNameRef} lastNameRef={lastNameRef} nextRef={emailRef}
              errors={fieldErrors} disabled={submitting || providerSubmitting}
              onChange={value => { setFirstName(value.firstName); setLastName(value.lastName); if (fieldErrors.firstName) setFieldErrors(prev => ({ ...prev, firstName: '' })); }}
              onBlur={() => { if (firstName || fieldErrors.firstName) setFieldErrors(prev => ({ ...prev, firstName: firstName.trim() ? '' : 'First name is required.' })); }} />
            <div className="space-y-2">
              <Label htmlFor="setup-email">Email</Label>
              <Input
                id="setup-email"
                ref={emailRef}
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                placeholder="admin@example.com"
                autoComplete="email"
                value={email}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? 'setup-email-error' : undefined}
                onChange={e => {
                  setEmail(e.target.value);
                  if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
                }}
                onBlur={() => {
                  if (email || fieldErrors.email) {
                    setFieldErrors(prev => ({ ...prev, email: validateEmail(email) }));
                  }
                }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); passwordRef.current?.focus(); } }}
              />
              {fieldErrors.email && (
                <p id="setup-email-error" className="text-xs text-destructive" role="alert">{fieldErrors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-password">Password</Label>
              <PasswordField
                id="setup-password"
                placeholder="At least 8 characters"
                autoComplete="new-password"
                enterKeyHint="next"
                inputRef={passwordRef}
                value={password}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={fieldErrors.password ? 'setup-password-error' : undefined}
                onChange={e => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setFieldErrors(prev => ({ ...prev, password: '' }));
                }}
                onBlur={() => {
                  if (password || fieldErrors.password) {
                    const msg = !password ? 'Password is required.' : password.length < 8 ? 'Password must be at least 8 characters.' : '';
                    setFieldErrors(prev => ({ ...prev, password: msg }));
                  }
                }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); confirmRef.current?.focus(); } }}
              />
              {fieldErrors.password && (
                <p id="setup-password-error" className="text-xs text-destructive" role="alert">{fieldErrors.password}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-confirm">Confirm password</Label>
              <PasswordField
                id="setup-confirm"
                autoComplete="new-password"
                enterKeyHint="go"
                inputRef={confirmRef}
                value={confirm}
                aria-invalid={fieldErrors.confirm ? true : undefined}
                aria-describedby={fieldErrors.confirm ? 'setup-confirm-error' : undefined}
                onChange={e => {
                  setConfirm(e.target.value);
                  if (fieldErrors.confirm) setFieldErrors(prev => ({ ...prev, confirm: '' }));
                }}
                onBlur={() => {
                  if (confirm || fieldErrors.confirm) {
                    setFieldErrors(prev => ({ ...prev, confirm: password && confirm !== password ? 'Passwords do not match.' : '' }));
                  }
                }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); handleSetup(e); } }}
              />
              {fieldErrors.confirm && (
                <p id="setup-confirm-error" className="text-xs text-destructive" role="alert">{fieldErrors.confirm}</p>
              )}
            </div>
            <Button
              type="submit"
              className="w-full gap-2 whitespace-nowrap shrink-0"
              disabled={submitting || providerSubmitting} focusableWhenDisabled
              aria-busy={submitting ? 'true' : undefined}
            >
              {submitting && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
              <span>{submitting ? 'Creating admin account...' : 'Create admin account'}</span>
            </Button>
          </form>
        </CardContent>
      </Card>
      {/* Every route shows this page until setup finishes, so there is no privacy page yet. */}
      <PublicFooter link={null} />
    </main>
  );
}
