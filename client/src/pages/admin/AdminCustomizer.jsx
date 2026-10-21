import { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { adminApi } from './adminApi.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { renderMd } from '../../lib/helpers.js';
import { buildThemeVars, contrastText, normalizeHex } from '../../lib/branding.js';
import { invalidatePublicBranding } from '../../lib/publicBranding.js';
import KnowledgeBaseEditor from './KnowledgeBaseEditor.jsx';

const DEFAULT_PRIMARY = '#8b1a1a';
const DEFAULT_ACCENT = '#dc2626';
const HEX_COLOR_ERROR = 'Enter a hex color like #8b1a1a.';

export default function AdminCustomizer() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname.replace(/\/+$/, '');
  const isKnowledgeRoute = path.endsWith('/knowledge') || path.endsWith('/knowledge/edit');
  const isEditKBRoute = path.endsWith('/knowledge/edit');
  const tab = isKnowledgeRoute ? 'knowledge' : 'styles';
  const setTab = (t) => navigate(t === 'knowledge' ? '/plato/customizer/knowledge' : '/plato/customizer', { replace: true });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [primary, setPrimary] = useState(DEFAULT_PRIMARY);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [logoBase64, setLogoBase64] = useState(null);
  const [classroomName, setClassroomName] = useState('');
  const [logoError, setLogoError] = useState('');
  const [colorErrors, setColorErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [styleMessage, setStyleMessage] = useState(null);

  // The preview keeps the last usable color while a hex code is mid-edit,
  // rather than going transparent behind white text.
  const safePrimary = normalizeHex(primary) || DEFAULT_PRIMARY;
  const safeAccent = normalizeHex(accent) || DEFAULT_ACCENT;

  // Expand shorthand (#abc) on blur; flag anything that isn't a color.
  function commitColor(field, value, setValue) {
    const normalized = normalizeHex(value);
    if (normalized) setValue(normalized);
    setColorErrors((prev) => ({ ...prev, [field]: normalized ? '' : HEX_COLOR_ERROR }));
    return normalized;
  }

  const [kbContent, setKbContent] = useState('');
  const [kbConversation, setKbConversation] = useState(null);
  const [kbReadiness, setKbReadiness] = useState(null);
  const [kbUpdatedAt, setKbUpdatedAt] = useState(null);
  const [kbUpdatedByName, setKbUpdatedByName] = useState(null);
  const [kbEditing, setKbEditing] = useState(isEditKBRoute);

  useEffect(() => {
    document.title = 'Classroom Customizer — plato';
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [themeData, kbData] = await Promise.all([
        adminApi('GET', '/v1/admin/theme'),
        adminApi('GET', '/v1/admin/knowledge-base'),
      ]);
      const t = themeData.theme || {};
      setPrimary(normalizeHex(t.primary) || DEFAULT_PRIMARY);
      setAccent(normalizeHex(t.accent) || DEFAULT_ACCENT);
      setLogoBase64(themeData.logoBase64 || null);
      setClassroomName(themeData.classroomName || '');
      setKbContent(kbData.content || '');
      setKbConversation(kbData.conversation || null);
      setKbReadiness(kbData.readiness ?? null);
      setKbUpdatedAt(kbData.updatedAt || null);
      setKbUpdatedByName(kbData.updatedByName || null);
    } catch (e) {
      setLoadError(e?.message || 'Customizer settings could not be loaded.');
    }
    setLoading(false);
  }

  async function saveStyle() {
    if (saving) return;
    const nextPrimary = commitColor('primary', primary, setPrimary);
    const nextAccent = commitColor('accent', accent, setAccent);
    if (!nextPrimary || !nextAccent) {
      document.getElementById(nextPrimary ? 'theme-accent-hex' : 'theme-primary-hex')?.focus();
      return;
    }
    setSaving(true);
    setStyleMessage(null);
    try {
      await adminApi('PUT', '/v1/admin/theme', { theme: { primary: nextPrimary, accent: nextAccent }, logoBase64, classroomName });
      // The classroom and sign-in pages read branding from a shared cache.
      invalidatePublicBranding();
      setStyleMessage({ text: 'Saved.', type: 'success' });
    } catch (e) { setStyleMessage({ text: e.message, type: 'error' }); }
    finally { setSaving(false); }
  }

  function handleLogoUpload(e) {
    const input = e.target;
    const file = input.files[0];
    if (!file) return;
    setLogoError('');
    // Clear a rejected file so the field doesn't keep showing its name and the
    // same file can be picked again after it's fixed.
    const reject = (text) => {
      setLogoError(text);
      input.value = '';
    };
    const unreadable = () => reject("That file couldn't be read. Try a PNG, JPG, WebP, or SVG.");
    if (file.type === 'image/svg+xml') {
      const reader = new FileReader();
      reader.onload = (ev) => setLogoBase64(ev.target.result);
      reader.onerror = unreadable;
      reader.readAsDataURL(file);
      return;
    }
    const reader = new FileReader();
    reader.onerror = unreadable;
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = unreadable;
      img.onload = () => {
        if (img.width < 512 || img.height < 512) {
          reject('Image must be at least 512x512px.');
          return;
        }
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.min(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        setLogoBase64(canvas.toDataURL('image/png'));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  if (loading) return <div className="flex items-center justify-center py-12 text-muted-foreground" role="status" aria-live="polite">Loading...</div>;

  if (loadError) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Classroom Customizer</h1>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-4 py-3 text-sm text-danger-foreground" role="alert">
          <span>{loadError} Nothing was changed.</span>
          <Button variant="outline" size="sm" onClick={loadAll}>Retry</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Classroom Customizer</h1>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList aria-label="Customizer sections">
          <TabsTrigger value="styles">Styles</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
        </TabsList>

        <TabsContent value="styles">
          <p className="text-sm text-muted-foreground mb-4">These settings only affect the learner-facing classroom.</p>

          <Card className="mb-6">
            <CardHeader><CardTitle as="h2">Colors</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">Set two colors — contrast is derived automatically.</p>
              <div className="flex flex-wrap gap-6">
                <div className="flex items-center gap-3">
                  <input id="theme-primary" type="color" value={safePrimary}
                    onChange={e => { setPrimary(e.target.value); setColorErrors((prev) => ({ ...prev, primary: '' })); }}
                    className="w-12 h-12 shrink-0 rounded-lg border border-border cursor-pointer p-0.5" aria-label="Primary color" />
                  <div className="space-y-1">
                    <Label htmlFor="theme-primary">Primary</Label>
                    <p className="text-xs text-muted-foreground">Header, buttons, badges</p>
                    <Input
                      id="theme-primary-hex"
                      type="text"
                      inputMode="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={7}
                      value={primary}
                      onChange={e => { setPrimary(e.target.value); setColorErrors((prev) => ({ ...prev, primary: '' })); }}
                      onBlur={e => commitColor('primary', e.target.value, setPrimary)}
                      aria-label="Primary color hex code"
                      aria-invalid={colorErrors.primary ? true : undefined}
                      aria-describedby={colorErrors.primary ? 'theme-primary-error' : undefined}
                      className="h-8 w-28 font-mono text-xs"
                    />
                    {colorErrors.primary && (
                      <p id="theme-primary-error" className="text-xs text-destructive" role="alert">{colorErrors.primary}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <input id="theme-accent" type="color" value={safeAccent}
                    onChange={e => { setAccent(e.target.value); setColorErrors((prev) => ({ ...prev, accent: '' })); }}
                    className="w-12 h-12 shrink-0 rounded-lg border border-border cursor-pointer p-0.5" aria-label="Accent color" />
                  <div className="space-y-1">
                    <Label htmlFor="theme-accent">Accent</Label>
                    <p className="text-xs text-muted-foreground">Links, focus rings</p>
                    <Input
                      id="theme-accent-hex"
                      type="text"
                      inputMode="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={7}
                      value={accent}
                      onChange={e => { setAccent(e.target.value); setColorErrors((prev) => ({ ...prev, accent: '' })); }}
                      onBlur={e => commitColor('accent', e.target.value, setAccent)}
                      aria-label="Accent color hex code"
                      aria-invalid={colorErrors.accent ? true : undefined}
                      aria-describedby={colorErrors.accent ? 'theme-accent-error' : undefined}
                      className="h-8 w-28 font-mono text-xs"
                    />
                    {colorErrors.accent && (
                      <p id="theme-accent-error" className="text-xs text-destructive" role="alert">{colorErrors.accent}</p>
                    )}
                  </div>
                </div>
              </div>
              <div className="classroom-theme rounded-lg overflow-hidden" aria-label="Theme preview" style={buildThemeVars({ primary: safePrimary, accent: safeAccent })}>
                <div className="px-4 py-2 flex flex-wrap items-center gap-2 text-sm" style={{ backgroundColor: safePrimary, color: contrastText(safePrimary) }}>
                  <span className="font-semibold">Header Preview</span>
                  <span className="ml-auto">Nav Item</span>
                </div>
                <div className="px-4 py-3 bg-background text-sm space-y-2">
                  <p>Body text on the page background.</p>
                  <a href="#" onClick={e => e.preventDefault()} className="text-link underline">Accent link</a>
                  <div className="flex gap-2 mt-2">
                    <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: safePrimary, color: contrastText(safePrimary) }}>Badge</span>
                    <span className="px-2 py-0.5 rounded text-xs font-medium border border-link text-link">Outline</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader><CardTitle as="h2">Classroom Identity</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="classroom-name">Classroom Name</Label>
                <Input id="classroom-name" type="text" value={classroomName} placeholder="e.g. AI Leaders Academy" onChange={e => setClassroomName(e.target.value)} />
                <p className="text-xs text-muted-foreground">Appears in the header, login pages, and browser tab.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="logo-file">Logo image (optional)</Label>
                <Input
                  id="logo-file"
                  type="file"
                  accept="image/svg+xml,image/png,image/jpeg,image/webp"
                  onChange={handleLogoUpload}
                  aria-invalid={logoError ? true : undefined}
                  aria-describedby={logoError ? 'logo-file-error logo-file-hint' : 'logo-file-hint'}
                />
                <p id="logo-file-hint" className="text-xs text-muted-foreground">Square, at least 512x512px. SVG preferred. If not set, the classroom name is displayed as text.</p>
                {logoError && <p id="logo-file-error" className="text-sm text-destructive" role="alert">{logoError}</p>}
              </div>
              <div className="p-4 rounded-lg text-center" style={{ backgroundColor: safePrimary, color: contrastText(safePrimary) }}>
                {logoBase64 ? (
                  <img src={logoBase64} alt={classroomName || 'Logo preview'} width="48" height="48" className="max-h-12 w-auto inline-block object-contain" />
                ) : (
                  <span className="text-lg font-semibold">{classroomName || 'Your Classroom'}</span>
                )}
              </div>
              {logoBase64 && (
                <Button variant="outline" size="sm" onClick={() => setLogoBase64(null)}>Remove logo image</Button>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={saveStyle} disabled={saving} focusableWhenDisabled>{saving ? 'Saving...' : 'Save'}</Button>
            {/* Always mounted so the result is announced when it appears. */}
            <span role="status" aria-live="polite" className={`text-sm ${styleMessage?.type === 'error' ? 'text-destructive' : 'text-success-foreground'}`}>
            {styleMessage && (
              <>
                {styleMessage.text}
                {styleMessage.type === 'success' && (
                  <>
                    {' '}
                    <Link to="/lessons" className="touch-target-inline underline underline-offset-4">Open the Classroom</Link>
                    {' '}to see your changes.
                  </>
                )}
              </>
            )}
            </span>
          </div>
        </TabsContent>

        <TabsContent value="knowledge">
          {kbEditing ? (
            <div>
              <div className="flex items-center gap-3 mb-4">
                <Button variant="ghost" size="sm" onClick={() => { setKbEditing(false); navigate('/plato/customizer/knowledge', { replace: true }); }} aria-label="Back to knowledge base">&larr; Back</Button>
                <h2 className="text-lg font-semibold">{kbContent ? 'Edit Knowledge Base' : 'Create Knowledge Base'}</h2>
              </div>
              <KnowledgeBaseEditor
                key={kbContent ? 'edit' : 'create'}
                initialContent={kbContent}
                initialConversation={kbConversation}
                initialReadiness={kbReadiness ?? 0}
                storageKey="plato_kb_customizer_draft"
                pageTitle="Classroom Customizer — plato"
                saveLabel={kbContent ? 'Update Knowledge Base' : 'Save Knowledge Base'}
                onSave={async (content, conversation, readiness) => {
                  await adminApi('PUT', '/v1/admin/knowledge-base', { content, conversation, readiness });
                  const fresh = await adminApi('GET', '/v1/admin/knowledge-base');
                  setKbContent(content);
                  setKbConversation(conversation);
                  setKbReadiness(readiness);
                  setKbEditing(false);
                  setKbUpdatedAt(fresh.updatedAt);
                  setKbUpdatedByName(fresh.updatedByName);
                  navigate('/plato/customizer/knowledge', { replace: true });
                }}
              />
            </div>
          ) : (
            <KBViewer
              content={kbContent}
              updatedAt={kbUpdatedAt}
              updatedByName={kbUpdatedByName}
              onEdit={() => {
                setKbEditing(true);
                navigate('/plato/customizer/knowledge/edit', { replace: true });
              }}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KBViewer({ content, updatedAt, updatedByName, onEdit }) {
  return (
    <div>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground max-w-prose">
            The coach and lesson creator use this knowledge base to understand your program.
          </p>
          {updatedAt && (
            <p className="text-xs text-muted-foreground mt-1">
              Last updated {new Date(updatedAt).toLocaleDateString()}{updatedByName ? ` by ${updatedByName}` : ''}
            </p>
          )}
        </div>
        <Button className="shrink-0" onClick={onEdit}>{content ? 'Edit Knowledge Base' : 'Create Knowledge Base'}</Button>
      </div>

      {content ? (
        <Card>
          <CardContent>
            <div className="coach-copy" dangerouslySetInnerHTML={{ __html: renderMd(content) }} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">No knowledge base yet.</p>
      )}
    </div>
  );
}
