import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { adminApi } from './adminApi.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { renderMd } from '../../lib/helpers.js';
import AdminStyles from './AdminStyles.jsx';
import KnowledgeBaseEditor from './KnowledgeBaseEditor.jsx';

function useResource(path) {
  const [request, setRequest] = useState({ attempt: 0, fallback: null });
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let active = true;
    adminApi('GET', path).then(data => {
      if (active) setState({ loading: false, data, error: null });
    }).catch(error => {
      if (active) setState({ loading: false, data: request.fallback, error: request.fallback ? null : error.message || 'Settings could not be loaded.' });
    });
    return () => { active = false; };
  }, [path, request]);
  return {
    ...state,
    // The error stays up, with its button showing progress, until the retry settles.
    retry: () => {
      setState(previous => ({ ...previous, loading: true }));
      setRequest(previous => ({ attempt: previous.attempt + 1, fallback: null }));
    },
    update: data => setState({ loading: false, data, error: null }),
    refresh: data => {
      // Show the acknowledged save immediately. Metadata refreshes can fail or
      // outlive navigation; the effect's cleanup ignores superseded results.
      setState({ loading: false, data, error: null });
      setRequest(previous => ({ attempt: previous.attempt + 1, fallback: data }));
    },
  };
}

function ResourceState({ resource, name, headingRef, children }) {
  // Focus stays on Retry while it works and if it fails again. When the content
  // replaces the button, the page heading takes the focus.
  const retried = useRef(false);
  useLayoutEffect(() => {
    if (resource.loading || !retried.current) return;
    retried.current = false;
    if (!resource.error && document.activeElement === document.body) headingRef.current?.focus();
  }, [resource.loading, resource.error, headingRef]);
  if (resource.error) return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-4 py-3 text-sm text-danger-foreground" role="alert">
      <span>{name} could not be loaded. {resource.error}</span>
      <Button variant="outline" size="sm" disabled={resource.loading} focusableWhenDisabled onClick={() => { retried.current = true; resource.retry(); }}>
        {resource.loading ? 'Retrying…' : `Retry ${name.toLowerCase()}`}
      </Button>
    </div>
  );
  if (resource.loading) return <p className="py-12 text-muted-foreground" role="status">Loading {name}...</p>;
  return children;
}

export default function AdminCustomizer() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname.replace(/\/+$/, '');
  const editing = path.endsWith('/knowledge/edit');
  const tab = editing || path.endsWith('/knowledge') ? 'knowledge' : 'styles';
  const styles = useResource('/v1/admin/theme');
  const knowledge = useResource('/v1/admin/knowledge-base');
  const kb = knowledge.data || {};
  const headingRef = useRef(null);
  const editorHeadingRef = useRef(null);
  const [knowledgeSaved, setKnowledgeSaved] = useState(false);

  useEffect(() => { document.title = 'Classroom Customizer — plato'; }, []);
  useLayoutEffect(() => {
    if (editing && !knowledge.loading && !knowledge.error) editorHeadingRef.current?.focus({ preventScroll: true });
  }, [editing, knowledge.loading, knowledge.error]);

  return (
    <div className={`customizer-page${editing ? ' customizer-page-editing' : ''}`}>
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold mb-4">Classroom Customizer</h1>
      <Tabs value={tab} onValueChange={value => navigate(value === 'knowledge' ? '/plato/customizer/knowledge' : '/plato/customizer', { replace: true })} className="space-y-4">
        <TabsList aria-label="Customizer sections">
          <TabsTrigger value="styles">Appearance</TabsTrigger>
          <TabsTrigger value="knowledge">Program knowledge</TabsTrigger>
        </TabsList>
        <TabsContent value="styles">
          <ResourceState resource={styles} name="Appearance" headingRef={headingRef}>
            {styles.data && <AdminStyles initialData={styles.data} onSaved={styles.update} />}
          </ResourceState>
        </TabsContent>
        <TabsContent value="knowledge">
          <ResourceState resource={knowledge} name="Knowledge base" headingRef={headingRef}>
            {editing ? (
              <div>
                <div className="knowledge-editor-header flex items-center gap-3 mb-4">
                  <Button variant="ghost" size="sm" onClick={() => navigate('/plato/customizer/knowledge', { replace: true })} aria-label="Back to knowledge base"><ArrowLeft className="size-4" aria-hidden="true" /> Back</Button>
                  <h2 ref={editorHeadingRef} tabIndex={-1} className="text-lg font-semibold">{kb.content ? 'Edit knowledge base' : 'Create knowledge base'}</h2>
                </div>
                <KnowledgeBaseEditor key={kb.content ? 'edit' : 'create'} initialContent={kb.content || ''} initialConversation={kb.conversation || null}
                  initialReadiness={kb.readiness ?? (kb.content ? 8 : 0)} storageKey="plato_kb_customizer_draft" pageTitle="Classroom Customizer — plato"
                  initialMode={new URLSearchParams(location.search).get('mode') === 'text' ? 'text' : 'conversation'}
                  saveLabel={kb.content ? 'Update knowledge base' : 'Save knowledge base'}
                  onSave={(content, conversation, readiness) => {
                    // The PUT is acknowledged. Navigation belongs to this save,
                    // never to a later GET; hide old attribution until refreshed.
                    knowledge.refresh({ ...kb, content, conversation, readiness, updatedAt: null, updatedByName: null });
                    setKnowledgeSaved(true);
                    navigate('/plato/customizer/knowledge', { replace: true });
                  }} />
              </div>
            ) : (
              <KBViewer content={kb.content || ''} updatedAt={kb.updatedAt} updatedByName={kb.updatedByName} saved={knowledgeSaved}
                onEdit={mode => {
                  // Reload first: draft turns from an earlier visit to the editor are
                  // newer than this page's copy, and the editor would overwrite them.
                  knowledge.retry();
                  setKnowledgeSaved(false);
                  navigate(`/plato/customizer/knowledge/edit${mode === 'text' ? '?mode=text' : ''}`, { replace: true });
                }} />
            )}
          </ResourceState>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KBViewer({ content, updatedAt, updatedByName, onEdit, saved }) {
  return (
    <div>
      {saved && <p role="status" className="text-sm text-success-foreground mb-4">Knowledge base saved. The coach and lesson creator now use this version.</p>}
      <div className="knowledge-viewer-header mb-4">
        <div className="knowledge-viewer-description min-w-0">
          <p className="text-sm text-muted-foreground max-w-prose">
            The coach and lesson creator use this knowledge base to understand your program.
          </p>
          {updatedAt && (
            <p className="text-xs text-muted-foreground mt-1">
              Last updated {new Date(updatedAt).toLocaleDateString()}{updatedByName ? ` by ${updatedByName}` : ''}
            </p>
          )}
        </div>
        <div className="knowledge-viewer-actions">
          <Button onClick={() => onEdit('conversation')}>{content ? 'Edit with assistant' : 'Create with assistant'}</Button>
          <Button variant="outline" onClick={() => onEdit('text')}>{content ? 'Edit text' : 'Write or paste text'}</Button>
        </div>
      </div>

      {content ? (
        <Card>
          <CardContent>
            <div className="knowledge-document coach-copy" dangerouslySetInnerHTML={{ __html: renderMd(content) }} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground max-w-prose">No knowledge base yet. Describe your program goals, learners, and teaching approach with the assistant, or write the reference yourself. Review it before saving.</p>
      )}
    </div>
  );
}
