import { useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import usePublicBranding from '../hooks/usePublicBranding.js';
import PasswordField from '../components/PasswordField.jsx';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Card, CardHeader, CardTitle, CardContent,
} from '@/components/ui/card';

export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('reset') || '';
  const passwordRef = useRef(null);
  const confirmRef = useRef(null);
  const branding = usePublicBranding('Set new password');

  async function handleReset(e) {
    if (e) e.preventDefault();
    if (submitting) return;
    const nextErrs = {};
    if (!password) nextErrs.password = 'Please enter a new password.';
    else if (password.length < 8) nextErrs.password = 'Password must be at least 8 characters.';
    if (password && password.length >= 8 && password !== confirm) {
      nextErrs.confirm = 'Passwords do not match.';
    }
    if (Object.keys(nextErrs).length > 0) {
      setFieldErrors(nextErrs);
      setError(nextErrs.password || nextErrs.confirm);
      if (nextErrs.password) passwordRef.current?.focus();
      else if (nextErrs.confirm) confirmRef.current?.focus();
      return;
    }
    setFieldErrors({});
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/v1/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetToken: token, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Reset failed');
      }
      setMessage('Password reset. You can now sign in.');
      setTimeout(() => navigate('/login', { replace: true }), 2000);
    } catch (e) {
      setError(e.message || 'Reset failed');
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
          <CardTitle className="text-2xl">Set new password</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleReset} noValidate>
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
              <Label htmlFor="reset-password">New password</Label>
              <PasswordField
                id="reset-password"
                placeholder="At least 8 characters"
                autoComplete="new-password"
                enterKeyHint="next"
                inputRef={passwordRef}
                value={password}
                disabled={submitting}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={fieldErrors.password ? 'reset-password-error' : undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setFieldErrors(prev => ({ ...prev, password: '' }));
                }}
                onBlur={() => {
                  if (password || fieldErrors.password) {
                    const msg = !password ? 'Please enter a new password.' : password.length < 8 ? 'Password must be at least 8 characters.' : '';
                    setFieldErrors(prev => ({ ...prev, password: msg }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); confirmRef.current?.focus(); } }}
              />
              {fieldErrors.password && (
                <p id="reset-password-error" className="text-xs text-destructive" role="alert">{fieldErrors.password}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-confirm">Confirm password</Label>
              <PasswordField
                id="reset-confirm"
                autoComplete="new-password"
                enterKeyHint="done"
                inputRef={confirmRef}
                value={confirm}
                disabled={submitting}
                aria-invalid={fieldErrors.confirm ? true : undefined}
                aria-describedby={fieldErrors.confirm ? 'reset-confirm-error' : undefined}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  if (fieldErrors.confirm) setFieldErrors(prev => ({ ...prev, confirm: '' }));
                }}
                onBlur={() => {
                  if (confirm || fieldErrors.confirm) {
                    setFieldErrors(prev => ({ ...prev, confirm: password && confirm !== password ? 'Passwords do not match.' : '' }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); handleReset(e); } }}
              />
              {fieldErrors.confirm && (
                <p id="reset-confirm-error" className="text-xs text-destructive" role="alert">{fieldErrors.confirm}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Resetting...' : 'Reset password'}
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="mt-4 text-xs" style={{ '--ring': 'currentColor' }}>
        <a href="/privacy" onClick={e => { e.preventDefault(); navigate('/privacy'); }} className="underline hover:no-underline">Privacy</a>
        {' · '}
        Powered by <a href="https://github.com/1111philo/plato" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">plato</a>.
      </p>
    </main>
  );
}
