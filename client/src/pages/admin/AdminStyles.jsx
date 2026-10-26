import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { Info, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog';
import { DEFAULT_PRIMARY, buildThemeVars, normalizeHex, themeColorNotes } from '../../lib/branding.js';
import { MAX_CLASSROOM_NAME, prepareLogo } from '../../lib/logoUpload.js';
import { invalidatePublicBranding } from '../../lib/publicBranding.js';
import { adminApi } from './adminApi.js';

const HEX_COLOR_ERROR = 'Enter a hex color like #470d99.';
const normalizeColor = value => /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value.trim()) ? normalizeHex(value) : null;
const defaultStyles = { primary: '#8b1a1a', accent: '#8b1a1a', matchPrimary: true, classroomName: '', logoBase64: null };

function stylesFrom(data) {
  const primary = normalizeHex(data.theme?.primary) || DEFAULT_PRIMARY;
  return {
    primary,
    accent: normalizeHex(data.theme?.accent) || primary,
    matchPrimary: !normalizeHex(data.theme?.accent),
    classroomName: typeof data.classroomName === 'string' ? data.classroomName.trim() : '',
    logoBase64: data.logoBase64 || null,
  };
}

export default function AdminStyles({ initialData, onSaved }) {
  const [draft, setDraft] = useState(() => stylesFrom(initialData));
  const [saved, setSaved] = useState(draft);
  const [preview, setPreview] = useState({ primary: draft.primary, accent: draft.accent });
  const [colorErrors, setColorErrors] = useState({});
  const [logoError, setLogoError] = useState('');
  const [processingLogo, setProcessingLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [styleMessage, setStyleMessage] = useState(null);
  const fileInput = useRef(null);
  const uploadEpoch = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const busy = saving || processingLogo;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (dirty || busy)
    && `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`);
  const safePrimary = preview.primary;
  const safeAccent = draft.matchPrimary ? safePrimary : preview.accent;
  const previewVars = buildThemeVars({ primary: safePrimary, accent: safeAccent });
  const colorNotes = themeColorNotes({ primary: safePrimary });
  const classroomName = draft.classroomName.trim() || 'plato';

  useEffect(() => () => { uploadEpoch.current++; }, []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);

  function change(values) {
    if (saving) return;
    setDraft(previous => ({ ...previous, ...values }));
    setStyleMessage(null);
  }

  function changeColor(field, value) {
    change({ [field]: value });
    setColorErrors(previous => ({ ...previous, [field]: '' }));
    // Only a complete six-digit value changes the preview while typing.
    // A deliberate shorthand value is accepted on blur or Save.
    if (/^#[\da-f]{6}$/i.test(value)) setPreview(previous => ({ ...previous, [field]: normalizeHex(value) }));
  }

  function commitColor(field, value) {
    const normalized = normalizeColor(value);
    if (normalized) {
      setDraft(previous => ({ ...previous, [field]: normalized }));
      setPreview(previous => ({ ...previous, [field]: normalized }));
    }
    setColorErrors(previous => ({ ...previous, [field]: normalized ? '' : HEX_COLOR_ERROR }));
    return normalized;
  }

  function restore(values) {
    uploadEpoch.current++;
    setProcessingLogo(false);
    setDraft(values);
    setPreview({ primary: values.primary, accent: values.accent });
    setColorErrors({});
    setLogoError('');
    setStyleMessage(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function handleLogoUpload(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    const epoch = ++uploadEpoch.current;
    setLogoError('');
    setStyleMessage(null);
    setProcessingLogo(true);
    try {
      const logoBase64 = await prepareLogo(file);
      if (epoch === uploadEpoch.current) change({ logoBase64 });
    } catch (error) {
      if (epoch === uploadEpoch.current) setLogoError(error.message || 'The logo could not be prepared. Try another image.');
    } finally {
      if (epoch === uploadEpoch.current) {
        setProcessingLogo(false);
        input.value = '';
      }
    }
  }

  function removeLogo() {
    uploadEpoch.current++;
    setProcessingLogo(false);
    setLogoError('');
    change({ logoBase64: null });
    if (fileInput.current) {
      fileInput.current.value = '';
      fileInput.current.focus();
    }
  }

  async function saveStyle() {
    if (busy || !dirty) return;
    const primary = commitColor('primary', draft.primary);
    const accent = draft.matchPrimary ? primary : commitColor('accent', draft.accent);
    if (!primary || !accent) {
      document.getElementById(primary ? 'theme-accent-hex' : 'theme-primary-hex')?.focus();
      return;
    }
    const next = { ...draft, primary, accent, classroomName: draft.classroomName.trim() };
    const data = { theme: { primary, ...(draft.matchPrimary ? {} : { accent }) }, logoBase64: draft.logoBase64, classroomName: next.classroomName };
    setSaving(true);
    setStyleMessage(null);
    try {
      const result = await adminApi('PUT', '/v1/admin/theme', data);
      setDraft(next);
      setSaved(next);
      setPreview({ primary, accent });
      onSaved(data);
      invalidatePublicBranding(result.branding || null);
      setStyleMessage({ text: 'Saved.', type: 'success' });
    } catch (error) {
      setStyleMessage({ text: error.message, type: 'error' });
    } finally { setSaving(false); }
  }

  return (
    <>
      <p className="text-sm text-muted-foreground mb-4">These settings affect the classroom, sign-in pages, and invitation and password reset emails.</p>
      <Card className="mb-6">
        <CardHeader><CardTitle as="h2">Colors</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">Choose your brand colors. Readable text and dark-mode shades are derived automatically.</p>
          <div className="flex flex-wrap gap-6">
            {['primary', 'accent'].map(field => {
              const matching = field === 'accent' && draft.matchPrimary;
              const description = `theme-${field}-hint${field === 'primary' && colorNotes.length ? ' theme-color-notes' : ''}${colorErrors[field] ? ` theme-${field}-error` : ''}`;
              return (
                <div key={field} className="flex items-start gap-3">
                  <input id={`theme-${field}`} type="color" value={field === 'primary' ? safePrimary : safeAccent}
                    disabled={saving || matching} onChange={event => changeColor(field, event.target.value)}
                    className="w-12 h-12 shrink-0 rounded-lg border border-border cursor-pointer p-0.5 disabled:cursor-default"
                    aria-label={`${field === 'primary' ? 'Primary' : 'Accent'} color`} aria-describedby={description} />
                  <div className="space-y-1">
                    <Label htmlFor={`theme-${field}`}>{field === 'primary' ? 'Primary' : 'Accent'}</Label>
                    <p id={`theme-${field}-hint`} className="text-xs text-muted-foreground">{field === 'primary' ? 'Header, buttons, badges' : 'Links, focus rings'}</p>
                    <Input id={`theme-${field}-hex`} type="text" inputMode="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={7}
                      value={matching ? draft.primary : draft[field]} readOnly={saving || matching}
                      onChange={event => changeColor(field, event.target.value)} onBlur={event => { if (!matching) commitColor(field, event.target.value); }}
                      aria-label={`${field === 'primary' ? 'Primary' : 'Accent'} color hex code`} aria-invalid={colorErrors[field] ? true : undefined}
                      aria-describedby={description} className="h-8 w-28 font-mono text-xs" />
                    {colorErrors[field] && <p id={`theme-${field}-error`} className="text-xs text-destructive" role="alert">{colorErrors[field]}</p>}
                    {field === 'accent' && (
                      <label className="flex min-h-11 items-center gap-2 py-2 text-sm cursor-pointer">
                        <input type="checkbox" checked={draft.matchPrimary} disabled={saving}
                          onChange={event => {
                            // Unmatching starts the accent from the primary on screen, not an older accent.
                            const matchPrimary = event.target.checked;
                            const accent = normalizeColor(draft.primary) || safePrimary;
                            change(matchPrimary ? { matchPrimary } : { matchPrimary, accent });
                            if (!matchPrimary) setPreview(previous => ({ ...previous, accent }));
                            setColorErrors(previous => ({ ...previous, accent: '' }));
                          }} />
                        Match primary
                      </label>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {['light', 'dark'].map(mode => (
              <figure key={mode} className="m-0 min-w-0 space-y-1.5" aria-label={`${mode === 'light' ? 'Light' : 'Dark'} mode preview`}>
                <div className={mode}>
                  <div className="classroom-theme rounded-lg overflow-hidden border" style={previewVars}>
                    <div className="px-4 py-2 flex min-h-12 items-center gap-2 text-sm bg-header text-header-foreground">
                      {draft.logoBase64 ? <img src={draft.logoBase64} alt={classroomName} height="32" className="h-8 w-auto max-w-full object-contain" />
                        : <span className="truncate font-semibold">{classroomName}</span>}
                    </div>
                    <div className="px-4 py-3 bg-workspace text-sm space-y-2 text-foreground">
                      <p>Body text on the page background.</p>
                      <a href="#" onClick={event => event.preventDefault()} className="text-link underline">Accent link</a>
                      <div className="flex flex-wrap gap-2 mt-2">
                        <Button type="button" size="sm">Button</Button>
                        <Button type="button" size="sm" variant="outline">Outline</Button>
                      </div>
                    </div>
                  </div>
                </div>
                <figcaption className="text-xs text-muted-foreground">{mode === 'light' ? 'Light mode' : 'Dark mode'}</figcaption>
              </figure>
            ))}
          </div>
          {colorNotes.length > 0 && (
            <ul id="theme-color-notes" className="space-y-1.5 text-sm" aria-label="Color notes" aria-live="polite">
              {colorNotes.map(note => (
                <li key={note.text} className={`flex gap-2 ${note.level === 'warning' ? 'text-warning-foreground' : 'text-muted-foreground'}`}>
                  {note.level === 'warning' ? <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
                  <span>{note.level === 'warning' && <span className="sr-only">Warning: </span>}{note.text}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card className="mb-6">
        <CardHeader><CardTitle as="h2">Classroom Identity</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="classroom-name">Classroom Name</Label>
            <Input id="classroom-name" type="text" value={draft.classroomName} maxLength={MAX_CLASSROOM_NAME} readOnly={saving}
              placeholder="e.g. AI Leaders Academy" onChange={event => change({ classroomName: event.target.value })} aria-describedby="classroom-name-hint" />
            <p id="classroom-name-hint" className="text-xs text-muted-foreground">Up to 100 characters. Leave blank to use plato.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="logo-file">Logo image (optional)</Label>
            <Input ref={fileInput} id="logo-file" type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" disabled={saving}
              onChange={handleLogoUpload} aria-invalid={logoError ? true : undefined} aria-describedby={logoError ? 'logo-file-error logo-file-hint' : 'logo-file-hint'} />
            <p id="logo-file-hint" className="text-xs text-muted-foreground">PNG, JPG, WebP, or SVG up to 5 MiB. Proportions and transparency are preserved; the logo is optimized to fit the header. Check both previews for visibility.</p>
            {processingLogo && <p role="status" className="text-sm text-muted-foreground">Preparing logo...</p>}
            {logoError && <p id="logo-file-error" className="text-sm text-destructive" role="alert">{logoError}</p>}
          </div>
          {draft.logoBase64 && <Button variant="outline" size="sm" onClick={removeLogo} disabled={saving}>Remove logo image</Button>}
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={saveStyle} disabled={busy || !dirty} focusableWhenDisabled>{saving ? 'Saving...' : 'Save'}</Button>
        <Button variant="outline" onClick={() => restore(saved)} disabled={saving || (!dirty && !processingLogo)} focusableWhenDisabled>Discard changes</Button>
        <Button variant="ghost" onClick={() => restore(defaultStyles)} disabled={saving}>Reset to defaults</Button>
        <span role="status" aria-live="polite" className={`text-sm ${styleMessage?.type === 'error' ? 'text-destructive' : styleMessage?.type === 'success' ? 'text-success-foreground' : 'text-muted-foreground'}`}>
          {styleMessage ? <>{styleMessage.text}{styleMessage.type === 'success' && <> <Link to="/lessons" className="touch-target-inline underline underline-offset-4">Open the Classroom</Link> to see your changes.</>}</>
            : dirty ? 'Unsaved changes' : ''}
        </span>
      </div>
      <AlertDialog open={blocker.state === 'blocked'} onOpenChange={open => { if (!open) blocker.reset?.(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>{saving ? 'Your styles are still saving. Stay here until the save finishes.' : 'Your Styles edits have not been saved. Leaving discards these edits.'}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => blocker.reset?.()}>Stay here</Button>
            <Button disabled={saving} onClick={() => blocker.proceed?.()}>Leave without saving</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
