import { useState, useEffect, useRef } from 'react';
import PasswordField from '../components/PasswordField.jsx';
import GoogleIcon from '../components/GoogleIcon.jsx';
import { saveAuthTokens, saveAuthUser } from '../../js/storage.js';
import { loginWithGoogle } from '../../js/auth.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

const SETUP_DRAFT_KEY = 'plato_setup_draft';

export default function Setup() {
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
  const [name, setName] = useState(savedDraft.name || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const nameRef = useRef(null);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    document.title = 'Setup — plato';
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(SETUP_DRAFT_KEY, JSON.stringify({ classroomName, email, name }));
    } catch { /* ignore */ }
  }, [classroomName, email, name]);

  async function handleGoogleSetup() {
    if (googleSubmitting || submitting) return;
    setGoogleSubmitting(true);
    setError('');
    try {
      await loginWithGoogle({
        classroomName: classroomName.trim() || undefined,
        name: name.trim() || undefined,
      });
      try { sessionStorage.removeItem(SETUP_DRAFT_KEY); } catch { /* ignore */ }
      window.location.href = '/plato';
    } catch (e) {
      if (e?.code !== 'auth/popup-closed-by-user') {
        setError(e.message || 'Google setup failed');
      }
    } finally {
      setGoogleSubmitting(false);
    }
  }

  function validateEmail(val) {
    const trimmed = val.trim();
    if (!trimmed) return 'Email is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'Please enter a valid email address.';
    return '';
  }

  async function handleSetup(e) {
    if (e) e.preventDefault();
    if (submitting || googleSubmitting) return;
    const nextErrs = {};
    if (!name.trim()) nextErrs.name = 'Name is required.';
    const emailErr = validateEmail(email);
    if (emailErr) nextErrs.email = emailErr;
    if (!password) nextErrs.password = 'Password is required.';
    else if (password.length < 8) nextErrs.password = 'Password must be at least 8 characters.';
    if (password && password.length >= 8 && password !== confirm) {
      nextErrs.confirm = 'Passwords do not match.';
    }

    if (Object.keys(nextErrs).length > 0) {
      setFieldErrors(nextErrs);
      if (!email.trim() || !name.trim() || !password) {
        setError('All fields are required.');
      } else if (nextErrs.email) {
        setError(nextErrs.email);
      } else if (nextErrs.password) {
        setError(nextErrs.password);
      } else if (nextErrs.confirm) {
        setError(nextErrs.confirm);
      }
      if (nextErrs.name) nameRef.current?.focus();
      else if (nextErrs.email) emailRef.current?.focus();
      else if (nextErrs.password) passwordRef.current?.focus();
      else if (nextErrs.confirm) confirmRef.current?.focus();
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/v1/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), name: name.trim(), password, classroomName: classroomName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Setup failed');
      try { sessionStorage.removeItem(SETUP_DRAFT_KEY); } catch { /* ignore */ }
      await saveAuthTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      await saveAuthUser(data.user);
      window.location.href = '/plato';
    } catch (e) {
      setError(e.message || 'Setup failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh shrink-0 flex flex-col items-center justify-start py-12 p-4 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]" style={{ backgroundColor: '#470d99' }}>
      <img src="/assets/logo-white.svg" alt="plato" width="160" height="40" fetchPriority="high" className="h-10 w-auto mb-6" />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Build your Classroom.</CardTitle>
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
                aria-describedby="setup-classroom-hint"
                value={classroomName}
                onChange={e => setClassroomName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); nameRef.current?.focus(); } }}
              />
              <p id="setup-classroom-hint" className="text-xs text-muted-foreground">This appears in the header and on login pages. You can change it later.</p>
            </div>
            <hr className="border-border" />
            <Button
              type="button"
              variant="outline"
              className="w-full gap-2 whitespace-nowrap shrink-0"
              onClick={handleGoogleSetup}
              disabled={submitting || googleSubmitting}
              aria-busy={googleSubmitting ? 'true' : undefined}
            >
              {googleSubmitting ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : (
                <GoogleIcon className="h-4 w-4 shrink-0" />
              )}
              <span>{googleSubmitting ? 'Setting up with Google...' : 'Create admin account with Google'}</span>
            </Button>
            <div className="relative flex items-center py-1">
              <div className="grow border-t border-border" />
              <span className="mx-3 shrink-0 text-xs text-muted-foreground">or set up with password</span>
              <div className="grow border-t border-border" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-name">Your Name</Label>
              <Input
                id="setup-name"
                ref={nameRef}
                type="text"
                enterKeyHint="next"
                placeholder="Your name"
                autoComplete="name"
                value={name}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? 'setup-name-error' : undefined}
                onChange={e => {
                  setName(e.target.value);
                  if (fieldErrors.name) setFieldErrors(prev => ({ ...prev, name: '' }));
                }}
                onBlur={() => {
                  if (name || fieldErrors.name) {
                    setFieldErrors(prev => ({ ...prev, name: name.trim() ? '' : 'Name is required.' }));
                  }
                }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); emailRef.current?.focus(); } }}
              />
              {fieldErrors.name && (
                <p id="setup-name-error" className="text-xs text-destructive" role="alert">{fieldErrors.name}</p>
              )}
            </div>
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
              disabled={submitting || googleSubmitting}
              aria-busy={submitting ? 'true' : undefined}
            >
              {submitting && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
              <span>{submitting ? 'Creating admin account...' : 'Create admin account'}</span>
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="mt-4 text-xs text-white" style={{ '--ring': 'currentColor' }}>
        Powered by <a href="https://github.com/1111philo/plato" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">plato</a>
      </p>
    </main>
  );
}
