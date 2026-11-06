import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { Check, Info, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog';
import ClassroomLogo from '../../components/ClassroomLogo.jsx';
import { buildThemeVars, normalizeHex, themeColorNotes, themeContrastReport } from '../../lib/branding.js';
import { readLogoPalette, suggestLogoTheme } from '../../lib/logoPalette.js';
import { MAX_CLASSROOM_NAME, dataUrlBlob, downloadOriginalLogo, prepareLogo } from '../../lib/logoUpload.js';
import { invalidatePublicBranding } from '../../lib/publicBranding.js';
import { DEFAULT_STYLES, changedStyles, normalizeColor, publishedStyles, stylesFrom } from '../../lib/stylesDraft.js';
import { adminApi } from './adminApi.js';
import './customizer.css';

const HEX_COLOR_ERROR = 'Enter a hex color like #470d99.';

// Leaving a hex field commits a shorthand color, which can reflow the color
// notes and move a button out from under the pointer before the click lands.
// Keep focus in the field instead; Save commits the value itself.
const holdHexFocus = event => {
  if (document.activeElement?.id?.endsWith('-hex')) event.preventDefault();
};

export default function AdminStyles({ initialData, onSaved }) {
  const [draft, setDraft] = useState(() => stylesFrom(initialData));
  const [saved, setSaved] = useState(draft);
  const [legacyLogo, setLegacyLogo] = useState(Boolean(initialData.logoLegacy));
  const [logoBlocked, setLogoBlocked] = useState(Boolean(initialData.logoBlocked));
  const [preview, setPreview] = useState({ primary: draft.primary, accent: draft.accent });
  const [colorErrors, setColorErrors] = useState({});
  const [logoError, setLogoError] = useState('');
  const [processingLogo, setProcessingLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [styleMessage, setStyleMessage] = useState(null);
  const [previewMode, setPreviewMode] = useState('light');
  const [logoPalette, setLogoPalette] = useState(null);
  const [paletteAttempt, setPaletteAttempt] = useState(0);
  const fileInput = useRef(null);
  const saveButton = useRef(null);
  const uploadEpoch = useRef(0);
  const focusSaveAfterOptimize = useRef(false);
  const dirty = Object.keys(changedStyles(draft, saved)).length > 0;
  const busy = saving || processingLogo;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (dirty || busy)
    && `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`);
  const safePrimary = preview.primary;
  const safeAccent = draft.matchPrimary ? safePrimary : preview.accent;
  const previewVars = buildThemeVars({ primary: safePrimary, accent: safeAccent });
  const colorNotes = themeColorNotes({ primary: safePrimary });
  const contrastReport = themeContrastReport({ primary: safePrimary, accent: safeAccent });
  const classroomName = draft.classroomName.trim() || 'plato';
  const blockedOriginal = Boolean(logoBlocked && draft.logoBase64 && draft.logoBase64 === saved.logoBase64);
  const paletteSource = blockedOriginal ? null : draft.logoBase64;
  const palette = logoPalette?.source === paletteSource ? logoPalette : null;
  const logoColors = palette?.colors || [];
  // Only rasters were padded: earlier versions stored SVG files unchanged.
  const showLegacyNotice = !blockedOriginal && legacyLogo && Boolean(draft.logoBase64) && draft.logoBase64 === saved.logoBase64
    && !draft.logoBase64.startsWith('data:image/svg+xml');

  useEffect(() => () => { uploadEpoch.current++; }, []);
  useEffect(() => {
    if (!paletteSource) return;
    const controller = new AbortController();
    readLogoPalette(paletteSource, { signal: controller.signal }).then(colors => {
      if (!controller.signal.aborted) setLogoPalette({ source: paletteSource, colors });
    }).catch(() => {
      if (!controller.signal.aborted) setLogoPalette({ source: paletteSource, colors: [], error: true });
    });
    return () => controller.abort();
  }, [paletteSource, paletteAttempt]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);
  // A navigation held while a save was in flight can go once that save lands.
  useEffect(() => {
    if (blocker.state === 'blocked' && !dirty && !busy) blocker.proceed();
  }, [blocker, dirty, busy]);
  // Optimize logo leaves with its notice once the logo is staged; Save, now
  // enabled, takes the focus it had.
  useLayoutEffect(() => {
    if (showLegacyNotice || !focusSaveAfterOptimize.current) return;
    focusSaveAfterOptimize.current = false;
    if (document.activeElement === document.body) saveButton.current?.focus();
  }, [showLegacyNotice]);

  function change(values) {
    if (saving) return;
    setDraft(previous => ({ ...previous, ...values }));
    setStyleMessage(null);
  }

  function changeColor(field, value) {
    if (saving) return;
    change({ [field]: value });
    setColorErrors(previous => ({ ...previous, [field]: '' }));
    // Only a complete six-digit value changes the preview while typing.
    // A deliberate shorthand value is accepted on blur or Save.
    if (/^#?[\da-f]{6}$/i.test(value.trim())) setPreview(previous => ({ ...previous, [field]: normalizeHex(value) }));
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

  function changeMatchPrimary(matchPrimary) {
    if (saving) return;
    // Unmatching starts the accent from the color it was just showing.
    const accent = normalizeColor(draft.primary) || preview.primary;
    change(matchPrimary ? { matchPrimary } : { matchPrimary, accent });
    if (!matchPrimary) setPreview(previous => ({ ...previous, accent }));
    setColorErrors(previous => ({ ...previous, accent: '' }));
  }

  function applyLogoColors() {
    if (busy) return;
    const colors = suggestLogoTheme(logoColors);
    if (!colors) return;
    change(colors);
    setPreview({ primary: colors.primary, accent: colors.accent });
    setColorErrors({});
    setStyleMessage({ text: 'Logo colors selected. Review both modes, then Save.', type: 'info' });
  }

  function applyLogoSwatch(field, hex) {
    if (busy) return;
    change({ [field]: hex, ...(field === 'accent' ? { matchPrimary: false } : {}) });
    setPreview(previous => ({ ...previous, [field]: hex }));
    setColorErrors(previous => ({ ...previous, [field]: '' }));
  }

  function restore(values, text) {
    uploadEpoch.current++;
    setProcessingLogo(false);
    setDraft(values);
    setPreview({ primary: values.primary, accent: values.accent });
    setColorErrors({});
    setLogoError('');
    setStyleMessage({ text, type: 'info' });
    if (fileInput.current) fileInput.current.value = '';
  }

  async function stageLogo(prepare, readyText, onStaged) {
    const epoch = ++uploadEpoch.current;
    setLogoError('');
    setStyleMessage(null);
    setProcessingLogo(true);
    try {
      const logoBase64 = await prepare();
      if (epoch === uploadEpoch.current) {
        change({ logoBase64 });
        setStyleMessage({ text: readyText, type: 'info' });
        onStaged?.();
      }
    } catch (error) {
      if (epoch === uploadEpoch.current) setLogoError(error.message || 'The logo could not be prepared. Try another image.');
    } finally {
      if (epoch === uploadEpoch.current) {
        setProcessingLogo(false);
        if (fileInput.current) fileInput.current.value = '';
      }
    }
  }

  function handleLogoUpload(event) {
    const file = event.target.files?.[0];
    if (!file || saving) return;
    stageLogo(() => prepareLogo(file), 'Logo ready. Check both previews, then Save.');
  }

  function optimizeLogo(event) {
    const hadFocus = [event.currentTarget, document.body].includes(document.activeElement);
    const stored = draft.logoBase64;
    stageLogo(() => prepareLogo(dataUrlBlob(stored), { trim: true }), 'Logo optimized. Check both previews, then Save.',
      () => { focusSaveAfterOptimize.current = hadFocus; });
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
    const data = changedStyles(next, saved);
    if (!Object.keys(data).length) {
      setDraft(next);
      return;
    }
    setSaving(true);
    setStyleMessage(null);
    try {
      const result = await adminApi('PUT', '/v1/admin/theme', data);
      // Show what the server now holds: the fields this save didn't send may
      // have been changed by another admin.
      let fresh = null;
      try { fresh = await adminApi('GET', '/v1/admin/theme'); } catch { /* Keep this tab's view. */ }
      const snapshot = fresh || { ...publishedStyles(next), logoLegacy: legacyLogo && !('logoBase64' in data), logoBlocked: logoBlocked && !('logoBase64' in data) };
      const view = fresh ? stylesFrom(fresh) : next;
      setDraft(view);
      setSaved(view);
      setPreview({ primary: view.primary, accent: view.accent });
      setLegacyLogo(Boolean(snapshot.logoLegacy));
      setLogoBlocked(Boolean(snapshot.logoBlocked));
      onSaved(snapshot);
      invalidatePublicBranding(result.branding || null);
      setStyleMessage({ text: 'Saved.', type: 'success' });
    } catch (error) {
      setStyleMessage({ text: error.message, type: 'error' });
    } finally { setSaving(false); }
  }

  return (
    <div className="customizer-appearance space-y-6">
      <p className="text-sm leading-relaxed text-muted-foreground max-w-prose">These settings affect the classroom, sign-in pages, and invitation and password reset emails.</p>
      <section className="space-y-3" aria-labelledby="appearance-identity-heading">
        <h2 id="appearance-identity-heading" className="text-lg font-semibold">Classroom Identity</h2>
        <div className="customizer-identity-grid">
          <div className="space-y-1.5">
            <Label htmlFor="classroom-name">Classroom Name</Label>
            <Input id="classroom-name" type="text" value={draft.classroomName} maxLength={MAX_CLASSROOM_NAME} readOnly={saving}
              placeholder="e.g. AI Leaders Academy" onChange={event => change({ classroomName: event.target.value })} aria-describedby="classroom-name-hint" />
            <p id="classroom-name-hint" className="text-xs leading-normal text-muted-foreground max-w-prose">Up to 100 characters, or leave blank for plato. Screen readers use this name for the logo.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="logo-file">Logo image (optional)</Label>
            <Input ref={fileInput} id="logo-file" type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" disabled={saving} onMouseDown={holdHexFocus}
              onChange={handleLogoUpload} aria-invalid={logoError ? true : undefined} aria-describedby={logoError ? 'logo-file-error logo-file-hint' : 'logo-file-hint'} />
            <p id="logo-file-hint" className="text-xs leading-normal text-muted-foreground max-w-prose">PNG, JPG, WebP, or SVG up to 5 MiB. Sized to fit the header while keeping proportions and transparency.</p>
            {processingLogo && <p role="status" className="text-sm text-muted-foreground">Preparing logo...</p>}
            {logoError && <p id="logo-file-error" className="text-sm text-destructive" role="alert">{logoError}</p>}
            {/* The logo's notices and actions stay in its column, not under the
                name beside it, with its actions in one row after the notice. */}
            {blockedOriginal && (
              <p className="pt-1.5 text-sm leading-relaxed text-warning-foreground max-w-prose" role="note" aria-label="Saved logo unavailable">This saved logo can&apos;t be displayed safely. The original is preserved. Download it, choose a simpler image, or remove it.</p>
            )}
            {showLegacyNotice && (
              <p className="flex gap-2 pt-1.5 text-sm leading-relaxed text-muted-foreground max-w-prose">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>An earlier version of plato padded this logo into a square, so it can look small in the header. Optimize it to trim the padding, or choose the original file again.</span>
              </p>
            )}
            {draft.logoBase64 && (
              <div className="flex flex-wrap gap-2 pt-1.5">
                {blockedOriginal && <Button variant="outline" size="sm" onMouseDown={holdHexFocus} onClick={() => downloadOriginalLogo(draft.logoBase64)}>Download original logo</Button>}
                {showLegacyNotice && <Button variant="outline" size="sm" onMouseDown={holdHexFocus} onClick={optimizeLogo} disabled={busy} focusableWhenDisabled>Optimize logo</Button>}
                <Button variant="outline" size="sm" onMouseDown={holdHexFocus} onClick={removeLogo} disabled={saving} focusableWhenDisabled>Remove logo image</Button>
              </div>
            )}
          </div>
        </div>
      </section>
      <section className="space-y-3 border-t border-border pt-5" aria-labelledby="appearance-colors-heading">
        <div className="space-y-1">
          <h2 id="appearance-colors-heading" className="text-lg font-semibold">Colors</h2>
          <p className="text-sm leading-relaxed text-muted-foreground max-w-prose">Start with your logo, or choose your own colors. Each mode gets readable shades of the same palette.</p>
        </div>
        {paletteSource && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button variant="outline" size="sm" onMouseDown={holdHexFocus} onClick={applyLogoColors}
              disabled={busy || !logoColors.length} focusableWhenDisabled>Use logo colors</Button>
            <span className="text-xs leading-normal text-muted-foreground" role="status">
              {!palette ? 'Finding logo colors…' : palette.error ? 'Colors could not be read. You can still choose them below.'
                : logoColors.length ? `${logoColors.length} logo ${logoColors.length === 1 ? 'color found' : 'colors found'}. Choose individual swatches below to fine-tune.`
                  : 'No clear colors found. Choose colors below or try another logo.'}
            </span>
            {palette?.error && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setLogoPalette(null); setPaletteAttempt(value => value + 1); }}>Retry logo colors</Button>}
          </div>
        )}
        <div className="customizer-color-grid">
          {['primary', 'accent'].map(field => {
            const matching = field === 'accent' && draft.matchPrimary;
            const description = `theme-${field}-hint${field === 'primary' && colorNotes.length ? ' theme-color-notes' : ''}${colorErrors[field] ? ` theme-${field}-error` : ''}`;
            return (
              <div key={field} className="flex items-start gap-3">
                <input id={`theme-${field}`} type="color" value={field === 'primary' ? safePrimary : safeAccent}
                  disabled={saving || matching} onChange={event => changeColor(field, event.target.value)}
                  className="w-11 h-11 shrink-0 rounded-lg border border-border cursor-pointer p-0.5 disabled:cursor-default"
                  aria-label={`${field === 'primary' ? 'Primary' : 'Accent'} color`} aria-describedby={description} />
                <div className="space-y-1">
                  <Label htmlFor={`theme-${field}`}>{field === 'primary' ? 'Primary' : 'Accent'}</Label>
                  <p id={`theme-${field}-hint`} className="text-xs leading-normal text-muted-foreground">{field === 'primary' ? 'Header, buttons, badges' : 'Links, focus rings'}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                    <Input id={`theme-${field}-hex`} type="text" inputMode="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={7}
                      value={matching ? draft.primary : draft[field]} readOnly={saving || matching}
                      onChange={event => changeColor(field, event.target.value)} onBlur={event => { if (!matching && !saving) commitColor(field, event.target.value); }}
                      aria-label={`${field === 'primary' ? 'Primary' : 'Accent'} color hex code`} aria-invalid={colorErrors[field] ? true : undefined}
                      aria-describedby={description} className={`h-9 w-28 font-mono text-sm tabular-nums ${matching ? 'text-muted-foreground' : ''}`} />
                    {field === 'accent' && (
                      <label className="touch-target inline-flex min-h-9 items-center gap-2 text-sm cursor-pointer select-none">
                        <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={draft.matchPrimary} disabled={saving}
                          onChange={event => changeMatchPrimary(event.target.checked)} />
                        Match primary
                      </label>
                    )}
                  </div>
                  {colorErrors[field] && <p id={`theme-${field}-error`} className="text-xs text-destructive" role="alert">{colorErrors[field]}</p>}
                  {logoColors.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1" role="group" aria-label={`Logo colors for ${field}`}>
                      {logoColors.map(hex => {
                        const selected = hex === (field === 'primary' ? safePrimary : safeAccent);
                        return <Button key={hex} variant="ghost" className="logo-color-swatch size-11 p-1.5" disabled={busy}
                          aria-label={`Use ${hex} as ${field}`} aria-pressed={selected} title={hex} onMouseDown={holdHexFocus} onClick={() => applyLogoSwatch(field, hex)}>
                          <span className="size-7 rounded-md border border-input" style={{ backgroundColor: hex }} aria-hidden="true" />
                          {selected && <Check className="logo-color-selected size-3" aria-hidden="true" />}
                        </Button>;
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className="space-y-3 border-t border-border pt-5" aria-labelledby="appearance-preview-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="appearance-preview-heading" className="text-lg font-semibold">Classroom preview</h2>
          <div className="appearance-preview-selector flex gap-1" role="group" aria-label="Preview color scheme">
            {['light', 'dark'].map(mode => <Button key={mode} size="sm" variant={previewMode === mode ? 'secondary' : 'ghost'}
              aria-pressed={previewMode === mode} onClick={() => setPreviewMode(mode)}>{mode === 'light' ? 'Light preview' : 'Dark preview'}</Button>)}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {['light', 'dark'].map(mode => (
            <figure key={mode} className={`m-0 min-w-0 space-y-1.5 ${previewMode !== mode ? 'appearance-preview-inactive' : ''}`} aria-label={`${mode === 'light' ? 'Light' : 'Dark'} mode preview`}>
              <div className={mode}>
                <div className="classroom-theme rounded-lg overflow-hidden border" style={previewVars}>
                  <div className="px-4 py-2 flex min-h-12 items-center gap-2 text-sm bg-header text-header-foreground">
                    {draft.logoBase64 && !blockedOriginal ? <ClassroomLogo src={draft.logoBase64} alt={classroomName} height="32" className="h-8 w-auto max-w-full object-contain" fallback={<span className="truncate font-semibold">{classroomName}</span>} />
                      : <span className="truncate font-semibold">{classroomName}</span>}
                  </div>
                  {/* Samples of the real controls, not controls: no tab stops. */}
                  <div className="px-4 py-3 bg-workspace text-sm space-y-2 text-foreground" inert>
                    <p>Body text on the page background.</p>
                    <span className="text-link underline">Accent link</span>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <Button type="button" size="sm" className="transition-none">Button</Button>
                      <Button type="button" size="sm" variant="outline" className="transition-none">Outline</Button>
                      <p className="ml-auto max-w-full rounded-2xl rounded-br-sm bg-bubble px-3 py-1 text-bubble-foreground">A learner&apos;s message</p>
                    </div>
                  </div>
                </div>
              </div>
              <figcaption className="text-xs text-muted-foreground">{mode === 'light' ? 'Light mode · Brand header' : 'Dark mode · Charcoal header'}</figcaption>
              <details className="theme-contrast-details text-xs">
                <summary className="touch-target cursor-pointer rounded-md py-1 text-muted-foreground">
                  {contrastReport.find(report => report.mode === mode).passes ? 'Color contrast checks pass' : 'Review color contrast'}
                </summary>
                <dl className="space-y-1 pt-1">
                  {contrastReport.find(report => report.mode === mode).checks.map(check => (
                    <div key={check.label} className={`flex flex-wrap justify-between gap-x-2 ${check.passes ? 'text-muted-foreground' : 'text-warning-foreground'}`}>
                      <dt>{check.label}</dt>
                      <dd className="tabular-nums">{check.ratio.toFixed(2)}:1 · {check.passes ? 'Pass' : 'Below'} {check.minimum}:1</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-2 leading-relaxed text-muted-foreground">Checks cover generated interface colors. Check the logo itself in both previews.</p>
                {mode === 'dark' && <p className="mt-2 leading-relaxed text-muted-foreground">Charcoal carries a subtle brand undertone. Bright accents soften for dark surfaces. Learners keep their own light or dark preference.</p>}
              </details>
            </figure>
          ))}
        </div>
        {/* Always mounted, so a note that appears is announced. No aria-label:
            it would replace the notes as the inputs' description. */}
        <div id="theme-color-notes" aria-live="polite">
          {colorNotes.length > 0 && (
            <ul className="space-y-1.5 text-sm leading-relaxed max-w-prose">
              {colorNotes.map(note => (
                <li key={note.text} className={`flex gap-2 ${note.level === 'warning' ? 'text-warning-foreground' : 'text-muted-foreground'}`}>
                  {note.level === 'warning' ? <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
                  <span>{note.level === 'warning' && <span className="sr-only">Warning: </span>}{note.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <div className="customizer-actions flex flex-wrap items-center gap-3 border-t border-border pt-4" data-pristine={!dirty && !busy && !styleMessage}>
        <Button ref={saveButton} onMouseDown={holdHexFocus} onClick={saveStyle} disabled={busy || !dirty} focusableWhenDisabled>{saving ? 'Saving...' : 'Save'}</Button>
        <Button variant="outline" onMouseDown={holdHexFocus} onClick={() => restore(saved, 'Changes discarded.')} disabled={saving || (!dirty && !processingLogo)} focusableWhenDisabled>Discard changes</Button>
        <Button variant="ghost" aria-label="Reset to defaults" onMouseDown={holdHexFocus} onClick={() => restore(DEFAULT_STYLES, Object.keys(changedStyles(DEFAULT_STYLES, saved)).length ? 'Defaults restored. Save to apply them.' : 'These are already the defaults.')} disabled={saving} focusableWhenDisabled>
          <span className="hidden sm:inline">Reset to defaults</span><span className="sm:hidden">Reset</span>
        </Button>
        <span role="status" aria-live="polite" className={`text-sm ${styleMessage?.type === 'error' ? 'text-destructive' : styleMessage?.type === 'success' ? 'text-success-foreground' : 'text-muted-foreground'}`}>
          {styleMessage ? <>{styleMessage.text}{styleMessage.type === 'success' && <> <Link to="/lessons" className="touch-target-inline underline underline-offset-4">Open the Classroom</Link> to see your changes.</>}</>
            : dirty ? 'Unsaved changes' : 'No unsaved changes'}
        </span>
      </div>
      <AlertDialog open={blocker.state === 'blocked'} onOpenChange={open => { if (!open) blocker.reset?.(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>{saving ? 'Your appearance changes are still saving. Stay here until the save finishes.' : 'Your appearance changes have not been saved. Leaving discards these edits.'}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay here</AlertDialogCancel>
            <Button disabled={saving} focusableWhenDisabled onClick={() => blocker.proceed?.()}>Leave without saving</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
