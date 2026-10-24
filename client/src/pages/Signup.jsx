import { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import usePublicBranding from '../hooks/usePublicBranding.js';
import { preloadFirebase } from '../../js/auth.js';
import PasswordField from '../components/PasswordField.jsx';
import GoogleIcon from '../components/GoogleIcon.jsx';
import CustomFieldInput from '../components/CustomFieldInput.jsx';
import { missingRequired, validateCustomField, validateCustomFields } from '../lib/userFields.js';
import { googleSignInError, missingFieldsMessage, requestError } from '../lib/authErrors.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
} from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

export default function Signup() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const draftKey = `plato_signup_draft:${token || 'default'}`;

  const [savedDraft] = useState(() => {
    try {
      const raw = sessionStorage.getItem(draftKey);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const [email, setEmail] = useState(savedDraft.email || '');
  const [name, setName] = useState(savedDraft.name || '');
  const [username, setUsername] = useState(savedDraft.username || '');
  const [group, setGroup] = useState(savedDraft.group || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [groups, setGroups] = useState([]);
  const [userFields, setUserFields] = useState([]);
  const [fieldValues, setFieldValues] = useState(savedDraft.fieldValues || {});
  const { login, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const emailRef = useRef(null);
  const nameRef = useRef(null);
  const usernameRef = useRef(null);
  const passwordRef = useRef(null);
  const confirmRef = useRef(null);
  const branding = usePublicBranding('Create account');

  useEffect(() => { preloadFirebase(); }, []);

  // Persist non-password signup draft across mobile background tab discards
  useEffect(() => {
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({ email, name, username, group, fieldValues })
      );
    } catch { /* ignore storage quota errors */ }
  }, [draftKey, email, name, username, group, fieldValues]);

  useEffect(() => {
    fetch('/v1/groups')
      .then(r => r.json())
      .then(d => setGroups(d.userGroups || []))
      .catch(() => {});
    fetch('/v1/user-fields')
      .then(r => r.json())
      .then(d => setUserFields(d.userFields || []))
      .catch(() => {});
  }, []);

  // An email invite fills in what it knows; a wait-list invite (#363) also
  // carries the person's name, group, and field answers.
  useEffect(() => {
    if (!token) return;
    fetch(`/v1/auth/invite/${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        if (d.email) setEmail(prev => prev || d.email);
        if (d.name) setName(prev => prev || d.name);
        if (d.userGroup) setGroup(prev => prev || d.userGroup);
        if (d.customFields) setFieldValues(prev => ({ ...d.customFields, ...prev }));
      })
      .catch(() => {});
  }, [token]);

  function validateOptionalEmail(val) {
    const trimmed = val.trim();
    if (!trimmed) return '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'Please enter a valid email address.';
    return '';
  }

  async function handleGoogleSignup() {
    const cfErrs = validateCustomFields(userFields, fieldValues);
    const cfIds = Object.keys(cfErrs);
    if (cfIds.length) {
      const nextErrs = {};
      for (const id of cfIds) nextErrs[`cf_${id}`] = cfErrs[id];
      setFieldErrors(prev => ({ ...prev, ...nextErrs }));
      const missing = missingRequired(userFields, fieldValues);
      if (missing.length) {
        const labels = userFields.filter(f => missing.includes(f.id)).map(f => f.label);
        setError(`Please fill in: ${labels.join(', ')}.`);
      } else {
        setError(cfErrs[cfIds[0]]);
      }
      document.getElementById(`signup-field-${cfIds[0]}`)?.focus();
      return;
    }
    if (googleSubmitting || submitting) return;
    setGoogleSubmitting(true);
    setError('');
    try {
      await loginWithGoogle({
        inviteToken: token || undefined,
        name: name.trim() || undefined,
        username: username.trim() || undefined,
        userGroup: group || undefined,
        customFields: userFields.length ? fieldValues : undefined,
      });
      try { sessionStorage.removeItem(draftKey); } catch { /* ignore */ }
      navigate('/lessons', { replace: true });
    } catch (e) {
      const msg = googleSignInError(e);
      if (msg) setError(msg);
    } finally {
      setGoogleSubmitting(false);
    }
  }

  async function handleSignup(e) {
    if (e) e.preventDefault();
    if (submitting || googleSubmitting) return;
    // Email is optional in frontend validation for backwards compatibility:
    // - Email-specific invites: backend uses invite.email if not provided
    // - Link invites: backend will reject with "Email is required" error
    // This prevents breaking in-flight email invite URLs sent before deployment.
    const nextErrs = {};
    const emailErr = validateOptionalEmail(email);
    if (emailErr) nextErrs.email = emailErr;
    if (!name.trim()) nextErrs.name = 'Name is required.';
    if (!password) nextErrs.password = 'Password is required.';
    else if (password.length < 8) nextErrs.password = 'Password must be at least 8 characters.';
    if (password && password.length >= 8 && password !== confirm) {
      nextErrs.confirm = 'Passwords do not match.';
    }
    const cfErrs = validateCustomFields(userFields, fieldValues);
    const cfIds = Object.keys(cfErrs);
    for (const id of cfIds) {
      nextErrs[`cf_${id}`] = cfErrs[id];
    }
    const missing = missingRequired(userFields, fieldValues);

    if (Object.keys(nextErrs).length > 0) {
      setFieldErrors(nextErrs);
      const missingBasics = [!name.trim() && 'your name', !password && 'a password'].filter(Boolean);
      if (missingBasics.length) {
        setError(missingFieldsMessage(missingBasics));
      } else if (nextErrs.email) {
        setError(nextErrs.email);
      } else if (nextErrs.password) {
        setError(nextErrs.password);
      } else if (nextErrs.confirm) {
        setError(nextErrs.confirm);
      } else if (missing.length) {
        const labels = userFields.filter(f => missing.includes(f.id)).map(f => f.label);
        setError(`Please fill in: ${labels.join(', ')}.`);
      } else if (cfIds.length) {
        setError(cfErrs[cfIds[0]]);
      }
      if (nextErrs.email) emailRef.current?.focus();
      else if (nextErrs.name) nameRef.current?.focus();
      else if (cfIds.length) document.getElementById(`signup-field-${cfIds[0]}`)?.focus();
      else if (nextErrs.password) passwordRef.current?.focus();
      else if (nextErrs.confirm) confirmRef.current?.focus();
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inviteToken: token,
          email: email.trim() || undefined, // Send undefined if empty (backend handles it)
          name: name.trim(),
          username: username.trim() || undefined,
          password,
          userGroup: group || undefined,
          customFields: userFields.length ? fieldValues : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "We couldn't create your account. Try again.");
      try { sessionStorage.removeItem(draftKey); } catch { /* ignore */ }
      // Log in with the returned credentials
      await login(data.user?.email || email.trim(), password);
      navigate('/lessons', { replace: true });
    } catch (e) {
      setError(requestError(e, "We couldn't create your account. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  if (!branding) return null;

  return (
    <main className="min-h-dvh shrink-0 flex flex-col items-center justify-start py-12 p-4 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] bg-header text-header-foreground">
      {branding.logo ? (<img src={branding.logo} alt={branding.classroomName} width="64" height="64" fetchPriority="high" className="h-16 w-16 mb-6 rounded-lg object-contain" />) : (<p className="max-w-full break-words text-center text-2xl font-bold mb-6">{branding.classroomName}</p>)}
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle as="h1" className="text-2xl">Create your account</CardTitle>
          <CardDescription>Join {branding.classroomName}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-lg p-3 text-sm" role="alert">
              {error}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2 whitespace-nowrap shrink-0"
            onClick={handleGoogleSignup}
            disabled={submitting || googleSubmitting} focusableWhenDisabled
            aria-busy={googleSubmitting ? 'true' : undefined}
          >
            {googleSubmitting ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <GoogleIcon className="h-4 w-4 shrink-0" />
            )}
            <span>{googleSubmitting ? 'Continuing with Google...' : 'Continue with Google'}</span>
          </Button>
          <div className="relative flex items-center py-1">
            <div className="grow border-t border-border" />
            <span className="mx-3 shrink-0 text-xs text-muted-foreground">or create account with password</span>
            <div className="grow border-t border-border" />
          </div>
          <form className="space-y-4" onSubmit={handleSignup} noValidate>
            <div className="space-y-2">
              <Label htmlFor="signup-email">Email</Label>
              <Input
                id="signup-email"
                ref={emailRef}
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                placeholder="your.email@example.com"
                autoComplete="email"
                value={email}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? 'signup-email-error' : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
                }}
                onBlur={() => {
                  if (email || fieldErrors.email) {
                    setFieldErrors(prev => ({ ...prev, email: validateOptionalEmail(email) }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); nameRef.current?.focus(); } }}
              />
              {fieldErrors.email && (
                <p id="signup-email-error" className="text-xs text-destructive" role="alert">{fieldErrors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-name">Name</Label>
              <Input
                id="signup-name"
                ref={nameRef}
                type="text"
                enterKeyHint="next"
                placeholder="Your name"
                autoComplete="name"
                value={name}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? 'signup-name-error' : undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  if (fieldErrors.name) setFieldErrors(prev => ({ ...prev, name: '' }));
                }}
                onBlur={() => {
                  if (name || fieldErrors.name) {
                    setFieldErrors(prev => ({ ...prev, name: name.trim() ? '' : 'Name is required.' }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); usernameRef.current?.focus(); } }}
              />
              {fieldErrors.name && (
                <p id="signup-name-error" className="text-xs text-destructive" role="alert">{fieldErrors.name}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-username">
                Username <span className="text-muted-foreground text-xs">(optional)</span>
              </Label>
              <Input
                id="signup-username"
                ref={usernameRef}
                type="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                placeholder="Choose a username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (userFields.length > 0) {
                      document.getElementById(`signup-field-${userFields[0].id}`)?.focus();
                    } else {
                      passwordRef.current?.focus();
                    }
                  }
                }}
              />
            </div>
            {groups.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="signup-group">
                  Group <span className="text-muted-foreground text-xs">(optional)</span>
                </Label>
                <select
                  id="signup-group"
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base md:text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="">Select group</option>
                  {groups.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
            )}
            {userFields.map((f, idx) => (
              <CustomFieldInput
                key={f.id}
                field={f}
                idPrefix="signup-field"
                enterKeyHint="next"
                value={fieldValues[f.id]}
                error={fieldErrors[`cf_${f.id}`]}
                onChange={(v) => {
                  setFieldValues(prev => ({ ...prev, [f.id]: v }));
                  if (fieldErrors[`cf_${f.id}`]) setFieldErrors(prev => ({ ...prev, [`cf_${f.id}`]: '' }));
                }}
                onBlur={() => {
                  if (f.required || fieldValues[f.id] || fieldErrors[`cf_${f.id}`]) {
                    const err = validateCustomField(f, fieldValues[f.id]);
                    if (f.required && !fieldValues[f.id] && !fieldErrors[`cf_${f.id}`] && fieldValues[f.id] === undefined) return;
                    setFieldErrors(prev => ({ ...prev, [`cf_${f.id}`]: err }));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    const nextField = userFields[idx + 1];
                    if (nextField) {
                      document.getElementById(`signup-field-${nextField.id}`)?.focus();
                    } else {
                      passwordRef.current?.focus();
                    }
                  }
                }}
              />
            ))}
            <div className="space-y-2">
              <Label htmlFor="signup-password">Password</Label>
              <PasswordField
                id="signup-password"
                placeholder="At least 8 characters"
                autoComplete="new-password"
                enterKeyHint="next"
                inputRef={passwordRef}
                value={password}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={fieldErrors.password ? 'signup-password-error' : undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setFieldErrors(prev => ({ ...prev, password: '' }));
                }}
                onBlur={() => {
                  if (password || fieldErrors.password) {
                    const msg = !password ? 'Password is required.' : password.length < 8 ? 'Password must be at least 8 characters.' : '';
                    setFieldErrors(prev => ({ ...prev, password: msg }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); confirmRef.current?.focus(); } }}
              />
              {fieldErrors.password && (
                <p id="signup-password-error" className="text-xs text-destructive" role="alert">{fieldErrors.password}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-confirm">Confirm password</Label>
              <PasswordField
                id="signup-confirm"
                autoComplete="new-password"
                enterKeyHint="go"
                inputRef={confirmRef}
                value={confirm}
                aria-invalid={fieldErrors.confirm ? true : undefined}
                aria-describedby={fieldErrors.confirm ? 'signup-confirm-error' : undefined}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  if (fieldErrors.confirm) setFieldErrors(prev => ({ ...prev, confirm: '' }));
                }}
                onBlur={() => {
                  if (confirm || fieldErrors.confirm) {
                    setFieldErrors(prev => ({ ...prev, confirm: password && confirm !== password ? 'Passwords do not match.' : '' }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); handleSignup(e); } }}
              />
              {fieldErrors.confirm && (
                <p id="signup-confirm-error" className="text-xs text-destructive" role="alert">{fieldErrors.confirm}</p>
              )}
            </div>
            <Button
              type="submit"
              className="w-full gap-2 whitespace-nowrap shrink-0"
              disabled={submitting || googleSubmitting} focusableWhenDisabled
              aria-busy={submitting ? 'true' : undefined}
            >
              {submitting && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
              <span>{submitting ? 'Creating account...' : 'Create account'}</span>
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center">
          <Button variant="link" onClick={() => navigate('/login')}>
            Already have an account? Sign in
          </Button>
        </CardFooter>
      </Card>
      <p className="mt-4 text-xs" style={{ '--ring': 'currentColor' }}>
        <a href="/privacy" onClick={e => { e.preventDefault(); navigate('/privacy'); }} className="underline hover:no-underline">Privacy</a>
        {' · '}
        Powered by <a href="https://github.com/1111philo/plato" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">plato</a>.
      </p>
    </main>
  );
}
