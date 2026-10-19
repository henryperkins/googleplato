import { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import usePublicBranding from '../hooks/usePublicBranding.js';
import PasswordField from '../components/PasswordField.jsx';
import CustomFieldInput from '../components/CustomFieldInput.jsx';
import { missingRequired } from '../lib/userFields.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
} from '@/components/ui/card';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [group, setGroup] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [groups, setGroups] = useState([]);
  const [userFields, setUserFields] = useState([]);
  const [fieldValues, setFieldValues] = useState({});
  const { login, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const confirmRef = useRef(null);
  const branding = usePublicBranding('Create account');

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

  async function handleGoogleSignup() {
    const missing = missingRequired(userFields, fieldValues);
    if (missing.length) {
      const labels = userFields.filter(f => missing.includes(f.id)).map(f => f.label);
      setError(`Please fill in: ${labels.join(', ')}.`);
      return;
    }
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
      navigate('/lessons', { replace: true });
    } catch (e) {
      if (e?.code !== 'auth/popup-closed-by-user') {
        setError(e.message || 'Google signup failed');
      }
    } finally {
      setGoogleSubmitting(false);
    }
  }

  async function handleSignup() {
    // Email is optional in frontend validation for backwards compatibility:
    // - Email-specific invites: backend uses invite.email if not provided
    // - Link invites: backend will reject with "Email is required" error
    // This prevents breaking in-flight email invite URLs sent before deployment.
    if (!name.trim() || !password) {
      setError('Name and password are required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    const missing = missingRequired(userFields, fieldValues);
    if (missing.length) {
      const labels = userFields.filter(f => missing.includes(f.id)).map(f => f.label);
      setError(`Please fill in: ${labels.join(', ')}.`);
      return;
    }
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      // Log in with the returned credentials
      await login(data.user?.email || email.trim(), password);
      navigate('/lessons', { replace: true });
    } catch (e) {
      setError(e.message || 'Signup failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!branding) return null;

  return (
    <main className="min-h-dvh shrink-0 flex flex-col items-center justify-start py-12 p-4" style={{ backgroundColor: branding.primary, color: branding.foreground }}>
      {branding.logo ? (<img src={branding.logo} alt={branding.classroomName} className="h-16 w-16 mb-6 rounded-lg object-contain" />) : (<h1 className="max-w-full break-words text-center text-2xl font-bold mb-6">{branding.classroomName}</h1>)}
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Create your account</CardTitle>
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
            disabled={submitting || googleSubmitting}
          >
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 15.25 5 12c0-3.25 3.36-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z" />
            </svg>
            {googleSubmitting ? 'Continuing with Google...' : 'Continue with Google'}
          </Button>
          <div className="relative flex items-center py-1">
            <div className="grow border-t border-border" />
            <span className="mx-3 shrink-0 text-xs text-muted-foreground">or create account with password</span>
            <div className="grow border-t border-border" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="signup-email">Email</Label>
            <Input
              id="signup-email"
              type="email"
              placeholder="your.email@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="signup-name">Name</Label>
            <Input
              id="signup-name"
              type="text"
              placeholder="Your name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="signup-username">
              Username <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              id="signup-username"
              type="text"
              placeholder="Choose a username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          {groups.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="signup-group">
                User Group <span className="text-muted-foreground text-xs">(optional)</span>
              </Label>
              <select
                id="signup-group"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              >
                <option value="">Select group</option>
                {groups.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          )}
          {userFields.map(f => (
            <CustomFieldInput
              key={f.id}
              field={f}
              idPrefix="signup-field"
              value={fieldValues[f.id]}
              onChange={(v) => setFieldValues(prev => ({ ...prev, [f.id]: v }))}
            />
          ))}
          <div className="space-y-2">
            <Label htmlFor="signup-password">Password</Label>
            <PasswordField
              id="signup-password"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="signup-confirm">Confirm password</Label>
            <PasswordField
              id="signup-confirm"
              autoComplete="new-password"
              inputRef={confirmRef}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSignup(); }}
            />
          </div>
          <Button className="w-full" onClick={handleSignup} disabled={submitting || googleSubmitting}>
            {submitting ? 'Creating...' : 'Create account'}
          </Button>
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
