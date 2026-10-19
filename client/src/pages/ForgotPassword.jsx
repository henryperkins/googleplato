import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import usePublicBranding from '../hooks/usePublicBranding.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
} from '@/components/ui/card';

const FORGOT_DRAFT_KEY = 'plato_forgot_password_draft';

export default function ForgotPassword() {
  const [email, setEmail] = useState(() => {
    try { return sessionStorage.getItem(FORGOT_DRAFT_KEY) || ''; } catch { return ''; }
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const emailRef = useRef(null);
  const branding = usePublicBranding('Reset password');

  useEffect(() => {
    try {
      if (email) sessionStorage.setItem(FORGOT_DRAFT_KEY, email);
      else sessionStorage.removeItem(FORGOT_DRAFT_KEY);
    } catch { /* ignore storage quota errors */ }
  }, [email]);

  function validateEmail(val) {
    const trimmed = val.trim();
    if (!trimmed) return 'Please enter your email.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'Please enter a valid email address.';
    return '';
  }

  async function handleSubmit(e) {
    if (e) e.preventDefault();
    if (submitting) return;
    const emailErr = validateEmail(email);
    if (emailErr) {
      setFieldError(emailErr);
      setError(emailErr);
      emailRef.current?.focus();
      return;
    }
    setFieldError('');
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/v1/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Request failed');
      }
      try { sessionStorage.removeItem(FORGOT_DRAFT_KEY); } catch { /* ignore */ }
      setMessage('If that email exists, a reset link has been sent. Check your inbox.');
    } catch (e) {
      setError(e.message || 'Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!branding) return null;

  return (
    <main className="min-h-dvh shrink-0 flex flex-col items-center justify-center p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]" style={{ backgroundColor: branding.primary, color: branding.foreground }}>
      {branding.logo ? (<img src={branding.logo} alt={branding.classroomName} width="64" height="64" fetchPriority="high" className="h-16 w-16 mb-6 rounded-lg object-contain" />) : (<h1 className="max-w-full break-words text-center text-2xl font-bold mb-6">{branding.classroomName}</h1>)}
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Reset password</CardTitle>
          <CardDescription>Enter your email and we&apos;ll send you a reset link.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            {error && (
              <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-lg p-3 text-sm" role="alert">
                {error}
              </div>
            )}
            {message && (
              <div className="bg-green-50 text-green-700 border border-green-200 rounded-lg p-3 text-sm" role="status">
                {message}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="forgot-email">Email</Label>
              <Input
                id="forgot-email"
                ref={emailRef}
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                placeholder="you@example.com"
                autoComplete="email"
                value={email}
                disabled={submitting}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'forgot-email-error' : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (fieldError) setFieldError('');
                }}
                onBlur={() => {
                  if (email || fieldError) {
                    setFieldError(validateEmail(email));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); handleSubmit(e); } }}
              />
              {fieldError && (
                <p id="forgot-email-error" className="text-xs text-destructive" role="alert">{fieldError}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Sending...' : 'Send reset link'}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center">
          <Button variant="link" onClick={() => navigate('/login')}>
            Back to sign in
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
