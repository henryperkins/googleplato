import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import usePublicBranding from '../hooks/usePublicBranding.js';
import CustomFieldInput from '../components/CustomFieldInput.jsx';
import { missingRequired } from '../lib/userFields.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
} from '@/components/ui/card';

const WAITLIST_DRAFT_KEY = 'plato_waitlist_draft';

// Join the wait list (#363). Asks for what signup asks, minus the password;
// an admin invites the person later from Admin → Users.
export default function Waitlist() {
  const [savedDraft] = useState(() => {
    try {
      const raw = sessionStorage.getItem(WAITLIST_DRAFT_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [open, setOpen] = useState(null);
  const [email, setEmail] = useState(savedDraft.email || '');
  const [name, setName] = useState(savedDraft.name || '');
  const [group, setGroup] = useState(savedDraft.group || '');
  const [groups, setGroups] = useState([]);
  const [userFields, setUserFields] = useState([]);
  const [fieldValues, setFieldValues] = useState(savedDraft.fieldValues || {});
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot — see below
  const navigate = useNavigate();
  const nameRef = useRef(null);
  const emailRef = useRef(null);
  const branding = usePublicBranding('Join the wait list');

  useEffect(() => {
    try {
      sessionStorage.setItem(WAITLIST_DRAFT_KEY, JSON.stringify({ email, name, group, fieldValues }));
    } catch { /* ignore */ }
  }, [email, name, group, fieldValues]);

  useEffect(() => {
    fetch('/v1/waitlist')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setOpen(!!d?.open))
      .catch(() => setOpen(false));
    fetch('/v1/groups')
      .then(r => r.json())
      .then(d => setGroups(d.userGroups || []))
      .catch(() => {});
    fetch('/v1/user-fields')
      .then(r => r.json())
      .then(d => setUserFields(d.userFields || []))
      .catch(() => {});
  }, []);

  async function handleSubmit(e) {
    if (e) e.preventDefault();
    const nextErrs = {};
    if (!name.trim()) nextErrs.name = 'Name is required.';
    if (!email.trim()) nextErrs.email = 'Email is required.';
    const missing = missingRequired(userFields, fieldValues);
    for (const id of missing) {
      const def = userFields.find(f => f.id === id);
      nextErrs[`cf_${id}`] = `${def?.label || 'This field'} is required.`;
    }

    if (Object.keys(nextErrs).length > 0) {
      setFieldErrors(nextErrs);
      if (!name.trim() || !email.trim()) {
        setError('Name and email are required.');
      } else if (missing.length) {
        const labels = userFields.filter(f => missing.includes(f.id)).map(f => f.label);
        setError(`Please fill in: ${labels.join(', ')}.`);
      }
      if (nextErrs.name) nameRef.current?.focus();
      else if (nextErrs.email) emailRef.current?.focus();
      else if (missing.length) document.getElementById(`waitlist-field-${missing[0]}`)?.focus();
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/v1/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          userGroup: group || undefined,
          customFields: userFields.length ? fieldValues : undefined,
          website: website || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not join the wait list');
      try { sessionStorage.removeItem(WAITLIST_DRAFT_KEY); } catch { /* ignore */ }
      setDone(true);
    } catch (e) {
      setError(e.message || 'Could not join the wait list');
    } finally {
      setSubmitting(false);
    }
  }

  if (!branding || open === null) return null;

  let body;
  if (done) {
    body = (
      <CardContent>
        <p role="status">You are on the wait list. We will email you when you are invited.</p>
      </CardContent>
    );
  } else if (!open) {
    body = (
      <CardContent>
        <p>The wait list is closed right now.</p>
      </CardContent>
    );
  } else {
    body = (
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          {error && (
            <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-lg p-3 text-sm" role="alert">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="waitlist-name">Name</Label>
            <Input
              id="waitlist-name"
              ref={nameRef}
              type="text"
              enterKeyHint="next"
              autoComplete="name"
              value={name}
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? 'waitlist-name-error' : undefined}
              onChange={(e) => {
                setName(e.target.value);
                if (fieldErrors.name) setFieldErrors(prev => ({ ...prev, name: '' }));
              }}
              onBlur={() => {
                if (name || fieldErrors.name) {
                  setFieldErrors(prev => ({ ...prev, name: name.trim() ? '' : 'Name is required.' }));
                }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); emailRef.current?.focus(); } }}
            />
            {fieldErrors.name && (
              <p id="waitlist-name-error" className="text-xs text-destructive" role="alert">{fieldErrors.name}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="waitlist-email">Email</Label>
            <Input
              id="waitlist-email"
              ref={emailRef}
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint={userFields.length > 0 ? 'next' : 'done'}
              autoComplete="email"
              placeholder="your.email@example.com"
              value={email}
              aria-invalid={fieldErrors.email ? true : undefined}
              aria-describedby={fieldErrors.email ? 'waitlist-email-error' : undefined}
              onChange={(e) => {
                setEmail(e.target.value);
                if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
              }}
              onBlur={() => {
                if (email || fieldErrors.email) {
                  setFieldErrors(prev => ({ ...prev, email: email.trim() ? '' : 'Email is required.' }));
                }
              }}
            />
            {fieldErrors.email && (
              <p id="waitlist-email-error" className="text-xs text-destructive" role="alert">{fieldErrors.email}</p>
            )}
          </div>
          {groups.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="waitlist-group">
                User Group <span className="text-muted-foreground text-xs">(optional)</span>
              </Label>
              <select
                id="waitlist-group"
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base md:text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              >
                <option value="">Select group</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          )}
          {userFields.map((f, idx) => (
            <CustomFieldInput
              key={f.id}
              field={f}
              idPrefix="waitlist-field"
              enterKeyHint={idx === userFields.length - 1 ? 'done' : 'next'}
              value={fieldValues[f.id]}
              error={fieldErrors[`cf_${f.id}`]}
              onChange={(v) => {
                setFieldValues(prev => ({ ...prev, [f.id]: v }));
                if (fieldErrors[`cf_${f.id}`]) setFieldErrors(prev => ({ ...prev, [`cf_${f.id}`]: '' }));
              }}
              onBlur={() => {
                if (f.required && (fieldValues[f.id] !== undefined || fieldErrors[`cf_${f.id}`])) {
                  const isMissing = missingRequired([f], fieldValues).includes(f.id);
                  setFieldErrors(prev => ({ ...prev, [`cf_${f.id}`]: isMissing ? `${f.label} is required.` : '' }));
                }
              }}
            />
          ))}
          {/* Honeypot: off-screen, hidden from assistive tech, and out of the tab
              order, so only bots fill it. The server silently drops those. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label htmlFor="waitlist-website">Website</label>
            <input id="waitlist-website" type="text" name="website" tabIndex={-1} autoComplete="off"
              value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? 'Sending...' : 'Join the wait list'}
          </Button>
        </form>
      </CardContent>
    );
  }

  return (
    <main className="min-h-dvh shrink-0 flex flex-col items-center justify-start py-12 p-4" style={{ backgroundColor: branding.primary, color: branding.foreground }}>
      {branding.logo ? (<img src={branding.logo} alt={branding.classroomName} className="h-16 w-16 mb-6 rounded-lg object-contain" />) : (<h1 className="max-w-full break-words text-center text-2xl font-bold mb-6">{branding.classroomName}</h1>)}
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Join the wait list</CardTitle>
          <CardDescription>Ask to join {branding.classroomName}.</CardDescription>
        </CardHeader>
        {body}
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
