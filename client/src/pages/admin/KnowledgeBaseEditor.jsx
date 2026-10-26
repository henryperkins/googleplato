import { useState, useEffect, useCallback, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { adminApi } from './adminApi.js';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog';
import { converseStream, extractKBMarkdown } from '../../../js/orchestrator.js';
import { parseResponse, cleanStream, buildConversationText } from '../../lib/lessonCreationEngine.js';
import { conversationForStorage, knowledgeBaseDraftWrites, knowledgeBaseEditorState, knowledgeBaseMarkdownForSave, savableKnowledgeBase, savedMessageCount } from '../../lib/knowledgeBaseDraft.js';
import { useStreamedText } from '../../hooks/useStreamedText.js';
import { useTitleNotification } from '../../hooks/useTitleNotification.js';
import { MSG_TYPES } from '../../lib/constants.js';
import { aiErrorMessage } from '../../lib/aiErrors.js';
import { readinessFill } from '../../lib/readiness.js';
import ChatArea from '../../components/chat/ChatArea.jsx';
import ComposeBar from '../../components/chat/ComposeBar.jsx';
import AssistantMessage from '../../components/chat/AssistantMessage.jsx';
import UserMessage from '../../components/chat/UserMessage.jsx';
import ThinkingSpinner from '../../components/chat/ThinkingSpinner.jsx';
import MarkdownPreviewPane from './MarkdownPreviewPane.jsx';

const DISMISS_CLASS = 'inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-lg leading-none hover:opacity-70';
const SAVE_STATES = ['creating', 'saving', 'saved'];

/**
 * Shared conversational knowledge-base editor. Used by the first-run setup
 * page and the Customizer → Knowledge tab so the two surfaces cannot drift.
 * The editor saves the knowledge base itself, then calls `onSave` so the page
 * can move on. Until then, leaving with unsaved changes asks for confirmation.
 */
export default function KnowledgeBaseEditor({
  initialContent = '',
  initialConversation = null,
  initialReadiness = 0,
  onSave,
  saveLabel = 'Save Knowledge Base',
  storageKey = 'plato_kb_editor_draft',
  pageTitle = 'Knowledge Base — plato',
}) {
  const isEditing = !!initialContent;
  const [chatMessages, setChatMessages] = useState(initialConversation || []);
  const [readiness, setReadiness] = useState(initialReadiness ?? 0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draftWarning, setDraftWarning] = useState('');

  const [streamingText, setStreamingText] = useState(null);
  const displayText = useStreamedText(streamingText);
  const pendingRef = useRef(null);
  const [srAnnouncement, setSrAnnouncement] = useState('');
  const notifyTitle = useTitleNotification(pageTitle);

  const [previewMarkdown, setPreviewMarkdown] = useState(initialContent || '');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  // The saved knowledge base and how many messages it includes. Later turns
  // are only a draft until the knowledge base is saved.
  const [savedMarkdown, setSavedMarkdown] = useState(initialContent || '');
  const [savedThrough, setSavedThrough] = useState(() => savedMessageCount(initialConversation));
  const [previewSyncedAt, setPreviewSyncedAt] = useState(
    () => (initialContent ? savedMessageCount(initialConversation) : 0)
  );

  const editor = knowledgeBaseEditorState({
    messageCount: chatMessages.length, savedMarkdown, savedThrough, previewMarkdown, previewSyncedAt,
    saving: busy === 'creating' || busy === 'saving', working: busy === 'qa' || previewLoading,
  });
  const leaveGuardRef = useRef(editor.leaveGuard);
  useEffect(() => { leaveGuardRef.current = editor.leaveGuard; }, [editor.leaveGuard]);
  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation }) => !!leaveGuardRef.current
    && `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`, []));
  useEffect(() => {
    if (!editor.leaveGuard) return;
    const beforeUnload = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [editor.leaveGuard]);

  const readinessRef = useRef(readiness);
  useEffect(() => { readinessRef.current = readiness; }, [readiness]);
  const savedThroughRef = useRef(savedThrough);
  useEffect(() => { savedThroughRef.current = savedThrough; }, [savedThrough]);
  useEffect(() => {
    if (chatMessages.length === 0) return;
    const conversation = conversationForStorage(chatMessages, savedThroughRef.current);
    knowledgeBaseDraftWrites.track(adminApi('PUT', '/v1/admin/knowledge-base/conversation', { conversation, readiness: readinessRef.current }))
      .then(() => setDraftWarning(''))
      .catch(() => setDraftWarning('Draft could not be saved. Your latest message is still on this page.'));
  }, [chatMessages]);

  useEffect(() => {
    if (displayText === null && pendingRef.current) {
      const { msgs, r, opening } = pendingRef.current;
      pendingRef.current = null;
      if (msgs) {
        setChatMessages(prev => [...prev, ...msgs]);
        if (opening) {
          // The greeting changes nothing, so it leaves the knowledge base saved.
          setSavedThrough(count => count + msgs.length);
          setPreviewSyncedAt(count => count + msgs.length);
        }
        if (msgs.some(m => m.role === 'assistant')) {
          setSrAnnouncement('');
          requestAnimationFrame(() => setSrAnnouncement('New message received'));
          notifyTitle();
        }
      }
      if (r != null) setReadiness(r);
      setBusy('');
    }
  }, [displayText, notifyTitle]);

  useEffect(() => {
    if (initialConversation?.length) return;
    let cancelled = false;
    setBusy('starting');
    setStreamingText('');

    const openingMessage = isEditing
      ? `I want to edit my existing knowledge base. Here is the current content:\n\n${initialContent}\n\nWhat would you like to know about the changes I want to make?`
      : 'I want to create a knowledge base for my program.';

    if (isEditing) {
      setChatMessages([{ role: 'user', content: openingMessage, msgType: MSG_TYPES.USER, timestamp: Date.now() }]);
      // The opening request repeats the saved knowledge base, so it changes nothing.
      setSavedThrough(1);
      setPreviewSyncedAt(1);
    }

    (async () => {
      try {
        const raw = await converseStream(
          'knowledge-base-editor',
          [{ role: 'user', content: openingMessage }],
          cleanStream((partial) => { if (!cancelled) setStreamingText(partial); }),
          512
        );
        if (cancelled) return;
        const { text, readiness: r } = parseResponse(raw);
        const msg = { role: 'assistant', content: text, msgType: MSG_TYPES.GUIDE, timestamp: Date.now() };
        pendingRef.current = { msgs: [msg], r: r ?? (isEditing ? 8 : 1), opening: true };
        setStreamingText(null);
      } catch (e) {
        if (!cancelled) { setError(aiErrorMessage(e, 'kb-editor')); setBusy(''); setStreamingText(null); }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const chatMessagesRef = useRef(chatMessages);
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);

  const handleSend = useCallback(async ({ text }) => {
    if (!text?.trim()) return;
    setError('');
    setBusy('qa');
    setStreamingText('');

    const userMsg = { role: 'user', content: text, msgType: MSG_TYPES.USER, timestamp: Date.now() };
    setChatMessages(prev => [...prev, userMsg]);

    try {
      const tail = [...chatMessagesRef.current, userMsg].slice(-15).map(m => ({ role: m.role, content: m.content }));
      const raw = await converseStream(
        'knowledge-base-editor',
        tail,
        cleanStream((partial) => setStreamingText(partial)),
        512
      );
      const { text: respText, readiness: r } = parseResponse(raw);
      const assistantMsg = { role: 'assistant', content: respText, msgType: MSG_TYPES.GUIDE, timestamp: Date.now() };
      pendingRef.current = { msgs: [assistantMsg], r };
      setStreamingText(null);
    } catch (e) {
      setError(aiErrorMessage(e, 'kb-editor'));
      setStreamingText(null);
      setBusy('');
    }
  }, []);

  const isBusy = !!busy;
  const saveBlocked = readiness < 3;

  async function handleSaveKB() {
    if (isBusy || previewLoading || saveBlocked) return;
    setError('');
    setBusy(editor.previewCurrent ? 'saving' : 'creating');
    try {
      const { markdown, extracted } = await knowledgeBaseMarkdownForSave({
        previewMarkdown,
        previewCurrent: editor.previewCurrent,
        extract: () => extractKBMarkdown(buildConversationText(chatMessages), initialContent || undefined),
      });
      if (!savableKnowledgeBase(markdown, savedMarkdown)) {
        setError('Could not generate a knowledge base from the conversation. Keep adding information.');
        setBusy('');
        return;
      }
      if (extracted) {
        setPreviewMarkdown(markdown);
        setPreviewSyncedAt(chatMessages.length);
        setBusy('saving');
      }
      const conversation = conversationForStorage(chatMessages);
      await knowledgeBaseDraftWrites.wait();
      await adminApi('PUT', '/v1/admin/knowledge-base', { content: markdown, conversation, readiness });
      // Saved, so the page's navigation after onSave must not be blocked.
      leaveGuardRef.current = null;
      setSavedMarkdown(markdown);
      setSavedThrough(chatMessages.length);
      // Stays busy: the page leaves the editor after onSave.
      setBusy('saved');
      await onSave(markdown, conversation, readiness);
    } catch (e) {
      setError(aiErrorMessage(e, 'kb-builder'));
      setBusy('');
    }
  }

  async function handleRefreshPreview() {
    if (chatMessages.length === 0) {
      setPreviewError('Start the conversation first, then refresh.');
      return;
    }
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const md = await extractKBMarkdown(buildConversationText(chatMessages), initialContent || undefined);
      setPreviewMarkdown(md);
      setPreviewSyncedAt(chatMessages.length);
    } catch (e) {
      setPreviewError(aiErrorMessage(e, 'preview'));
    } finally {
      setPreviewLoading(false);
    }
  }

  const renderMessage = (msg, idx) => {
    if (msg.msgType === MSG_TYPES.USER) return <UserMessage key={idx} content={msg.content} />;
    return <AssistantMessage key={idx} content={msg.content} />;
  };

  return (
    <div>
      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger text-danger-foreground px-4 py-3 mb-4 text-sm" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss error" className={DISMISS_CLASS}>&times;</button>
        </div>
      )}
      {draftWarning && (
        <p className="text-sm text-warning-foreground mb-4" role="status">{draftWarning}</p>
      )}

      {(chatMessages.length > 0 || displayText != null) && (
        <div className="admin-sticky-bar sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur-xs flex flex-wrap items-end gap-3 mb-4">
          <div
            className="flex-1 min-w-40"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={10}
            aria-valuenow={readiness}
            aria-label={`Knowledge base readiness: ${readiness} out of 10`}
          >
            <div className="flex justify-between text-xs text-muted-foreground mb-1" aria-hidden="true">
              <span>Not ready</span>
              <span>Ready</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="progress-fill h-full rounded-full"
                style={{
                  transform: `scaleX(${readiness / 10})`,
                  backgroundColor: readinessFill(readiness),
                }}
              />
            </div>
          </div>
          <Button
            onClick={handleSaveKB}
            disabled={isBusy || previewLoading || saveBlocked}
            size="sm"
            className="shrink-0"
            aria-describedby={saveBlocked ? 'kb-save-hint' : undefined}
          >
            {SAVE_STATES.includes(busy) ? 'Saving...' : saveLabel}
          </Button>
          {saveBlocked && (
            <p id="kb-save-hint" className="basis-full text-xs text-muted-foreground">
              Tell the editor about your classroom goal, learners, and teachers before saving (readiness {readiness} of 10).
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-4">
        <div className="lg:w-3/5 min-w-0">
          <div className="rounded-2xl bg-muted/40 p-2 sm:p-4">
            <div className="mb-3">
              <ChatArea announcement={srAnnouncement}>
                {chatMessages.map(renderMessage)}
                {displayText != null && displayText.length > 0 && (
                  <AssistantMessage content={displayText} streaming />
                )}
                {busy === 'starting' && !displayText && <ThinkingSpinner text="Starting..." />}
                {busy === 'creating' && <ThinkingSpinner text="Generating knowledge base..." />}
                {busy === 'qa' && !displayText && <ThinkingSpinner />}
              </ChatArea>
            </div>
            <ComposeBar
              placeholder="Tell me about your program..."
              storageKey={storageKey}
              onSend={handleSend}
              busy={isBusy}
            />
          </div>
        </div>
        <div className="lg:w-2/5 min-w-0">
          <MarkdownPreviewPane
            markdown={previewMarkdown}
            loading={previewLoading}
            error={previewError}
            stale={editor.previewStale}
            saveLabel={saveLabel}
            saved={editor.saved}
            saveHint={editor.saved ? 'This is the saved knowledge base. Describe any changes in the conversation, then refresh the preview.' : undefined}
            refreshDisabled={previewLoading || isBusy}
            onRefresh={handleRefreshPreview}
            title="Knowledge base preview"
            ariaLabel="Knowledge base markdown preview"
            noun="knowledge base"
            emptyHint="Chat about your program, then generate a preview to review the knowledge base."
          />
        </div>
      </div>
      <AlertDialog open={blocker.state === 'blocked'} onOpenChange={open => { if (!open) blocker.reset?.(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              {editor.leaveGuard === 'saving' ? 'Your knowledge base is still saving. Stay here until the save finishes.'
                : editor.leaveGuard === 'working' ? 'The preview is still being generated. Leaving discards it.'
                  : isEditing ? 'Your knowledge base changes have not been saved. Leaving keeps the last saved version.'
                    : 'Your knowledge base has not been saved yet, so leaving does not create it.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => blocker.reset?.()}>Stay here</Button>
            <Button disabled={editor.leaveGuard === 'saving'} onClick={() => blocker.proceed?.()}>Leave without saving</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
