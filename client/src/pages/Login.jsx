import { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import usePublicBranding from '../hooks/usePublicBranding.js';
import { preloadFirebase } from '../../js/auth.js';
import { googleSignInError, passwordSignInError } from '../lib/authErrors.js';
import { returnPath } from '../lib/returnPath.js';
import PasswordField from '../components/PasswordField.jsx';
import GoogleIcon from '../components/GoogleIcon.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card, CardHeader, CardTitle, CardContent, CardFooter,
} from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

const LOGIN_DRAFT_KEY = 'plato_login_draft';

export default function Login() {
  const [email, setEmail] = useState(() => {
    try { return sessionStorage.getItem(LOGIN_DRAFT_KEY) || ''; } catch { return ''; }
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const { login, loginWithGoogle, signedOutReason } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Back to the page that sent the learner here (e.g. a lesson whose session expired).
  const returnTo = returnPath(location.state?.from);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const branding = usePublicBranding('Sign in');
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  useEffect(() => {
    try {
      if (email) sessionStorage.setItem(LOGIN_DRAFT_KEY, email);
      else sessionStorage.removeItem(LOGIN_DRAFT_KEY);
    } catch { /* ignore storage quota errors */ }
  }, [email]);

  useEffect(() => {
    fetch('/v1/waitlist')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setWaitlistOpen(!!d?.open))
      .catch(() => {});
  }, []);

  useEffect(() => { preloadFirebase(); }, []);

  function validateField(name, val) {
    if (name === 'email') return val.trim() ? '' : 'Please enter your email or username.';
    if (name === 'password') return val ? '' : 'Please enter your password.';
    return '';
  }

  async function handleLogin(e) {
    if (e) e.preventDefault();
    if (submitting || googleSubmitting) return;
    const emailErr = validateField('email', email);
    const passwordErr = validateField('password', password);
    if (emailErr || passwordErr) {
      // Each empty field explains itself; a banner would repeat it.
      setFieldErrors({ email: emailErr, password: passwordErr });
      setError('');
      if (emailErr) emailRef.current?.focus();
      else if (passwordErr) passwordRef.current?.focus();
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    setError('');
    try {
      await login(email.trim(), password);
      try { sessionStorage.removeItem(LOGIN_DRAFT_KEY); } catch { /* ignore */ }
      navigate(returnTo, { replace: true });
    } catch (e) {
      setError(passwordSignInError(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogleLogin() {
    if (googleSubmitting || submitting) return;
    setGoogleSubmitting(true);
    setError('');
    try {
      await loginWithGoogle();
      try { sessionStorage.removeItem(LOGIN_DRAFT_KEY); } catch { /* ignore */ }
      navigate(returnTo, { replace: true });
    } catch (e) {
      const msg = googleSignInError(e);
      if (msg) setError(msg);
    } finally {
      setGoogleSubmitting(false);
    }
  }

  if (!branding) return null;

  const { logo, classroomName } = branding;

  return (
    <main className="min-h-dvh shrink-0 flex flex-col items-center justify-center p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] bg-header text-header-foreground">
      {logo ? (
        <img src={logo} alt={classroomName} width="64" height="64" fetchPriority="high" className="h-16 w-16 mb-6 rounded-lg object-contain" />
      ) : (
        <p className="max-w-full break-words text-center text-2xl font-bold mb-6">{classroomName}</p>
      )}
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle as="h1" className="text-2xl">Sign in</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {signedOutReason === 'expired' && (
            <p className="rounded-lg border border-warning-border bg-warning p-3 text-sm text-warning-foreground" role="status">
              Your session expired, so you were signed out. Sign in again to continue.
            </p>
          )}
          {error && (
            <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-lg p-3 text-sm" role="alert">
              {error}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2 whitespace-nowrap shrink-0"
            onClick={handleGoogleLogin}
            disabled={submitting || googleSubmitting} focusableWhenDisabled
            aria-busy={googleSubmitting ? 'true' : undefined}
          >
            {googleSubmitting ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <GoogleIcon className="h-4 w-4 shrink-0" />
            )}
            <span>{googleSubmitting ? 'Signing in with Google...' : 'Continue with Google'}</span>
          </Button>
          <div className="relative flex items-center py-1">
            <div className="grow border-t border-border" />
            <span className="mx-3 shrink-0 text-xs text-muted-foreground">or sign in with password</span>
            <div className="grow border-t border-border" />
          </div>
          <form className="space-y-4" onSubmit={handleLogin} noValidate>
            <div className="space-y-2">
              <Label htmlFor="login-email">Email or Username</Label>
              <Input
                id="login-email"
                ref={emailRef}
                type="text"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                placeholder="you@example.com or username"
                autoComplete="username webauthn"
                value={email}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? 'login-email-error' : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
                }}
                onBlur={() => {
                  if (email || fieldErrors.email) {
                    setFieldErrors(prev => ({ ...prev, email: validateField('email', email) }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); passwordRef.current?.focus(); } }}
              />
              {fieldErrors.email && (
                <p id="login-email-error" className="text-xs text-destructive" role="alert">{fieldErrors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="login-password">Password</Label>
                {/* Padding (cancelled by negative margin) makes a 28px target without
                    moving the row; a 44px one would overlap the password field. */}
                <a
                  href="/forgot-password"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/forgot-password', { state: { email: email.trim() } });
                  }}
                  className="-my-1.5 py-1.5 text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                >
                  Forgot password?
                </a>
              </div>
              <PasswordField
                id="login-password"
                autoComplete="current-password"
                enterKeyHint="go"
                inputRef={passwordRef}
                value={password}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setFieldErrors(prev => ({ ...prev, password: '' }));
                }}
                onBlur={() => {
                  if (password || fieldErrors.password) {
                    setFieldErrors(prev => ({ ...prev, password: validateField('password', password) }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); handleLogin(e); } }}
              />
              {fieldErrors.password && (
                <p id="login-password-error" className="text-xs text-destructive" role="alert">{fieldErrors.password}</p>
              )}
            </div>
            <Button
              type="submit"
              className="w-full gap-2 whitespace-nowrap shrink-0"
              disabled={submitting || googleSubmitting} focusableWhenDisabled
              aria-busy={submitting ? 'true' : undefined}
            >
              {submitting && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
              <span>{submitting ? 'Signing in...' : 'Sign in'}</span>
            </Button>
          </form>
        </CardContent>
        {/* "Forgot password?" sits beside the Password label, so it isn't repeated here. */}
        {waitlistOpen && (
          <CardFooter className="flex-col gap-1 justify-center">
            <Button variant="link" onClick={() => navigate('/waitlist')}>No account? Join the wait list</Button>
          </CardFooter>
        )}
      </Card>
      <p className="mt-4 text-xs" style={{ '--ring': 'currentColor' }}>
        <a href="/privacy" onClick={e => { e.preventDefault(); navigate('/privacy'); }} className="underline hover:no-underline">Privacy</a>
        {' · '}
        Powered by <a href="https://github.com/1111philo/plato" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">plato</a>.
      </p>
    </main>
  );
}
