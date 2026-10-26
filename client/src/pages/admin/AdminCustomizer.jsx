import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
    retry: () => {
      setState(previous => ({ ...previous, loading: true, error: null }));
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

function ResourceState({ resource, name, children }) {
  if (resource.loading) return <p className="py-12 text-muted-foreground" role="status">Loading {name}...</p>;
  if (resource.error) return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-4 py-3 text-sm text-danger-foreground" role="alert">
      <span>{name} could not be loaded. {resource.error}</span>
      <Button variant="outline" size="sm" onClick={resource.retry}>Retry {name.toLowerCase()}</Button>
    </div>
  );
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

  useEffect(() => { document.title = 'Classroom Customizer — plato'; }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Classroom Customizer</h1>
      <Tabs value={tab} onValueChange={value => navigate(value === 'knowledge' ? '/plato/customizer/knowledge' : '/plato/customizer', { replace: true })} className="space-y-4">
        <TabsList aria-label="Customizer sections">
          <TabsTrigger value="styles">Styles</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
        </TabsList>
        <TabsContent value="styles">
          <ResourceState resource={styles} name="Styles">
            {styles.data && <AdminStyles initialData={styles.data} onSaved={styles.update} />}
          </ResourceState>
        </TabsContent>
        <TabsContent value="knowledge">
          <ResourceState resource={knowledge} name="Knowledge base">
            {editing ? (
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <Button variant="ghost" size="sm" onClick={() => navigate('/plato/customizer/knowledge', { replace: true })} aria-label="Back to knowledge base">&larr; Back</Button>
                  <h2 className="text-lg font-semibold">{kb.content ? 'Edit Knowledge Base' : 'Create Knowledge Base'}</h2>
                </div>
                <KnowledgeBaseEditor key={kb.content ? 'edit' : 'create'} initialContent={kb.content || ''} initialConversation={kb.conversation || null}
                  initialReadiness={kb.readiness ?? (kb.content ? 8 : 0)} storageKey="plato_kb_customizer_draft" pageTitle="Classroom Customizer — plato"
                  saveLabel={kb.content ? 'Update Knowledge Base' : 'Save Knowledge Base'}
                  onSave={(content, conversation, readiness) => {
                    // The PUT is acknowledged. Navigation belongs to this save,
                    // never to a later GET; hide old attribution until refreshed.
                    knowledge.refresh({ ...kb, content, conversation, readiness, updatedAt: null, updatedByName: null });
                    navigate('/plato/customizer/knowledge', { replace: true });
                  }} />
              </div>
            ) : (
              <KBViewer content={kb.content || ''} updatedAt={kb.updatedAt} updatedByName={kb.updatedByName}
                onEdit={() => {
                  // Reload first: draft turns from an earlier visit to the editor are
                  // newer than this page's copy, and the editor would overwrite them.
                  knowledge.retry();
                  navigate('/plato/customizer/knowledge/edit', { replace: true });
                }} />
            )}
          </ResourceState>
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
