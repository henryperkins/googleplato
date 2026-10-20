import { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { adminApi } from './adminApi.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { renderMd } from '../../lib/helpers.js';
import { buildThemeVars, contrastText } from '../../lib/branding.js';
import KnowledgeBaseEditor from './KnowledgeBaseEditor.jsx';

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

  const [primary, setPrimary] = useState('#8b1a1a');
  const [accent, setAccent] = useState('#dc2626');
  const [logoBase64, setLogoBase64] = useState(null);
  const [classroomName, setClassroomName] = useState('');
  const [logoError, setLogoError] = useState('');
  const [saving, setSaving] = useState(false);
  const [styleMessage, setStyleMessage] = useState(null);

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
      setPrimary(t.primary || '#8b1a1a');
      setAccent(t.accent || '#dc2626');
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
    setSaving(true);
    setStyleMessage(null);
    try {
      await adminApi('PUT', '/v1/admin/theme', { theme: { primary, accent }, logoBase64, classroomName });
      setStyleMessage({ text: 'Saved.', type: 'success' });
    } catch (e) { setStyleMessage({ text: e.message, type: 'error' }); }
    finally { setSaving(false); }
  }

  function handleLogoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    setLogoError('');
    if (file.type === 'image/svg+xml') {
      const reader = new FileReader();
      reader.onload = (ev) => setLogoBase64(ev.target.result);
      reader.readAsDataURL(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        if (img.width < 512 || img.height < 512) {
          setLogoError('Image must be at least 512x512px.');
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
          <p className="text-sm text-muted-foreground mb-4">Classroom style and branding. These settings only affect the learner-facing classroom.</p>

          <Card className="mb-6">
            <CardHeader><CardTitle>Colors</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">Set two colors — contrast is derived automatically.</p>
              <div className="flex flex-wrap gap-6">
                <div className="flex items-center gap-3">
                  <input id="theme-primary" type="color" value={primary} onChange={e => setPrimary(e.target.value)}
                    className="w-12 h-12 shrink-0 rounded-lg border border-border cursor-pointer p-0.5" aria-label="Primary color" />
                  <div className="space-y-1">
                    <Label htmlFor="theme-primary">Primary</Label>
                    <p className="text-xs text-muted-foreground">Header, buttons, badges</p>
                    <Input
                      type="text"
                      inputMode="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={7}
                      value={primary}
                      onChange={e => setPrimary(e.target.value)}
                      aria-label="Primary color hex code"
                      className="h-8 w-28 font-mono text-xs"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <input id="theme-accent" type="color" value={accent} onChange={e => setAccent(e.target.value)}
                    className="w-12 h-12 shrink-0 rounded-lg border border-border cursor-pointer p-0.5" aria-label="Accent color" />
                  <div className="space-y-1">
                    <Label htmlFor="theme-accent">Accent</Label>
                    <p className="text-xs text-muted-foreground">Links, focus rings</p>
                    <Input
                      type="text"
                      inputMode="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={7}
                      value={accent}
                      onChange={e => setAccent(e.target.value)}
                      aria-label="Accent color hex code"
                      className="h-8 w-28 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
              <div className="classroom-theme rounded-lg overflow-hidden" aria-label="Theme preview" style={buildThemeVars({ primary, accent })}>
                <div className="px-4 py-2 flex flex-wrap items-center gap-2 text-sm" style={{ backgroundColor: primary, color: contrastText(primary) }}>
                  <span className="font-semibold">Header Preview</span>
                  <span className="ml-auto">Nav Item</span>
                </div>
                <div className="px-4 py-3 bg-background text-sm space-y-2">
                  <p>Body text on the page background.</p>
                  <a href="#" onClick={e => e.preventDefault()} className="text-link underline">Accent link</a>
                  <div className="flex gap-2 mt-2">
                    <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: primary, color: contrastText(primary) }}>Badge</span>
                    <span className="px-2 py-0.5 rounded text-xs font-medium border border-link text-link">Outline</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader><CardTitle>Classroom Identity</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="classroom-name">Classroom Name</Label>
                <Input id="classroom-name" type="text" value={classroomName} placeholder="e.g. AI Leaders Academy" onChange={e => setClassroomName(e.target.value)} />
                <p className="text-xs text-muted-foreground">Appears in the header, login pages, and browser tab. Used as the logo text when no image is uploaded.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="logo-file">Logo image (optional)</Label>
                <Input id="logo-file" type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" onChange={handleLogoUpload} />
                <p className="text-xs text-muted-foreground">Square, at least 512x512px. SVG preferred. If not set, the classroom name is displayed as text.</p>
                {logoError && <p className="text-sm text-destructive">{logoError}</p>}
              </div>
              <div className="p-4 rounded-lg text-center" style={{ backgroundColor: primary, color: contrastText(primary) }}>
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
            <Button onClick={saveStyle} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
            {styleMessage && (
              <span role="status" aria-live="polite" className={`text-sm ${styleMessage.type === 'error' ? 'text-destructive' : 'text-success-foreground'}`}>
                {styleMessage.text}
                {styleMessage.type === 'success' && (
                  <>
                    {' '}
                    <Link to="/lessons" className="touch-target inline-flex items-center underline underline-offset-4">Open the Classroom</Link>
                    {' '}to see your changes.
                  </>
                )}
              </span>
            )}
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
            The knowledge base provides context to the Coach and Lesson Creator agents about your program.
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
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <p>No knowledge base yet. Click &quot;Create Knowledge Base&quot; to get started with the AI editor.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
