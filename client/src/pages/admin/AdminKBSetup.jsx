import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from './adminApi.js';
import { Button } from '@/components/ui/button';
import KnowledgeBaseEditor from './KnowledgeBaseEditor.jsx';

export default function AdminKBSetup() {
  const navigate = useNavigate();

  useEffect(() => {
    document.title = 'Set Up Knowledge Base — plato';
  }, []);

  async function handleSave(content, conversation, readiness) {
    await adminApi('PUT', '/v1/admin/knowledge-base', { content, conversation, readiness });
    navigate('/plato', { state: { notice: 'Knowledge base saved.' } });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h1 className="text-2xl font-bold min-w-0">Set Up Your Knowledge Base</h1>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => navigate('/plato')}>Skip for now</Button>
      </div>
      <p className="text-sm text-muted-foreground max-w-prose mb-6">
        The knowledge base tells plato&apos;s AI about your program — who you are, what you do, and how things work.
        Chat with the editor below to build it, or skip and come back later from the Customizer.
      </p>
      <KnowledgeBaseEditor
        onSave={handleSave}
        saveLabel="Save Knowledge Base"
        storageKey="plato_kb_setup_draft"
        pageTitle="Set Up Knowledge Base — plato"
      />
    </div>
  );
}
