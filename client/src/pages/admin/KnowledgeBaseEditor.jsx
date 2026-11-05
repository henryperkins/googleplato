import { useState, useEffect, useCallback, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { adminApi } from './adminApi.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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
import './customizer.css';

const DISMISS_CLASS = 'inline-flex size-11 shrink-0 items-center justify-center rounded-sm text-lg leading-none hover:opacity-70';

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
  initialMode = 'conversation',
}) {
  const isEditing = !!initialContent;
  const [chatMessages, setChatMessages] = useState(initialConversation || []);
  const [readiness, setReadiness] = useState(initialReadiness ?? 0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [errorSource, setErrorSource] = useState('');
  const [mode, setMode] = useState(initialMode);
  const [openingAttempt, setOpeningAttempt] = useState(0);
  const openingStarted = useRef(Boolean(initialConversation?.length));
  const [draftWarning, setDraftWarning] = useState('');

  const [streamingText, setStreamingText] = useState(null);
  const displayText = useStreamedText(streamingText);
  const pendingRef = useRef(null);
  const [srAnnouncement, setSrAnnouncement] = useState('');
  const notifyTitle = useTitleNotification(pageTitle);

  const [previewMarkdown, setPreviewMarkdown] = useState(initialContent || '');
  const [draftMarkdown, setDraftMarkdown] = useState(initialContent || '');
  const previewRegion = useRef(null);
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
    messageCount: chatMessages.length, savedMarkdown, savedThrough, previewMarkdown, previewSyncedAt, draftMarkdown,
    saving: busy === 'saving', working: !!busy || previewLoading,
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
    if (mode !== 'conversation' || openingStarted.current) return;
    let cancelled = false;
    // StrictMode probes setup/cleanup before the surviving effect starts.
    // Defer inference so the probe cannot claim the one opening attempt.
    const startup = setTimeout(() => {
      openingStarted.current = true;
      setBusy('starting');
      setStreamingText('');

      const openingMessage = draftMarkdown
        ? `I want to edit my knowledge base. Here is the current document draft:\n\n${draftMarkdown}\n\nWhat would you like to know about the changes I want to make?`
        : 'I want to create a knowledge base for my program.';

      if (draftMarkdown) {
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
          if (!cancelled) { setError(aiErrorMessage(e, 'kb-editor')); setErrorSource('opening'); setBusy(''); setStreamingText(null); }
        }
      })();

    }, 0);

    return () => { cancelled = true; clearTimeout(startup); };
  }, [mode, openingAttempt, draftMarkdown, isEditing]);

  const chatMessagesRef = useRef(chatMessages);
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);

  const handleSend = useCallback(async ({ text }) => {
    if (!text?.trim()) return;
    setError('');
    setErrorSource('');
    setBusy('qa');
    setStreamingText('');

    const userMsg = { role: 'user', content: text, msgType: MSG_TYPES.USER, timestamp: Date.now() };
    setChatMessages(prev => [...prev, userMsg]);

    try {
      const tail = [...chatMessagesRef.current, userMsg].slice(-15).map(m => ({ role: m.role, content: m.content }));
      if (draftMarkdown !== initialContent) {
        tail[tail.length - 1].content = `Current document draft (not yet saved):\n\n${draftMarkdown}\n\nRequested change:\n${text}`;
      }
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
      setErrorSource('reply');
      setStreamingText(null);
      setBusy('');
    }
  }, [draftMarkdown, initialContent]);

  const isBusy = !!busy || previewLoading;
  const generationBlocked = readiness < 3 || chatMessages.length === 0;
  const unreviewedText = draftMarkdown !== previewMarkdown;
  const saveBlocked = !editor.previewCurrent || editor.saved || !savableKnowledgeBase(previewMarkdown, savedMarkdown);

  async function handleSaveKB() {
    if (isBusy || previewLoading || saveBlocked) return;
    setError('');
    setErrorSource('');
    setBusy('saving');
    try {
      const { markdown } = await knowledgeBaseMarkdownForSave({
        previewMarkdown,
        previewCurrent: editor.previewCurrent,
      });
      if (!savableKnowledgeBase(markdown, savedMarkdown)) {
        setError('Add at least 50 characters, then review the text before saving.');
        setErrorSource('save');
        setBusy('');
        return;
      }
      const conversation = conversationForStorage(chatMessages);
      await knowledgeBaseDraftWrites.wait();
      const result = await adminApi('PUT', '/v1/admin/knowledge-base', { content: markdown, conversation, readiness });
      if (result?.ok !== true) throw new Error('The save was not confirmed. Your reviewed document is still here. Try saving again.');
      // Saved, so the page's navigation after onSave must not be blocked.
      leaveGuardRef.current = null;
      setSavedMarkdown(markdown);
      setSavedThrough(chatMessages.length);
      // Stays busy: the page leaves the editor after onSave.
      setBusy('saved');
      await onSave(markdown, conversation, readiness);
    } catch (e) {
      setError(aiErrorMessage(e, 'kb-builder'));
      setErrorSource('save');
      setBusy('');
    }
  }

  async function handleRefreshPreview() {
    if (isBusy) return;
    if (generationBlocked) {
      setPreviewError('Start the conversation first, then refresh.');
      return;
    }
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const md = await extractKBMarkdown(buildConversationText(chatMessages), draftMarkdown || undefined);
      if (!savableKnowledgeBase(md, savedMarkdown)) throw new Error('The preview is incomplete. Add more program detail or edit the text directly, then try again.');
      setPreviewMarkdown(md);
      setDraftMarkdown(md);
      setPreviewSyncedAt(chatMessages.length);
    } catch (e) {
      setPreviewError(aiErrorMessage(e, 'preview'));
    } finally {
      setPreviewLoading(false);
    }
  }

  function reviewText() {
    if (isBusy || !savableKnowledgeBase(draftMarkdown, savedMarkdown)) return;
    setPreviewMarkdown(draftMarkdown);
    setPreviewSyncedAt(chatMessages.length);
    setPreviewError('');
    setError('');
    setErrorSource('');
    requestAnimationFrame(() => previewRegion.current?.focus());
  }

  const renderMessage = (msg, idx) => {
    if (msg.msgType === MSG_TYPES.USER) return <UserMessage key={idx} content={msg.content} />;
    return <AssistantMessage key={idx} content={msg.content} />;
  };

  return (
    <div className="knowledge-base-editor">
      <Tabs value={mode} onValueChange={setMode} className="gap-0">
        <TabsList aria-label="Knowledge editing method" className="knowledge-mode-tabs mb-4">
          <TabsTrigger value="conversation" disabled={isBusy}>Conversation</TabsTrigger>
          <TabsTrigger value="text" disabled={isBusy}>Edit text</TabsTrigger>
        </TabsList>
        <p className="text-sm text-muted-foreground mb-5 max-w-prose">
          Work with the assistant or edit the text yourself. Both use the same draft.
          Review the preview before saving; the coach and lesson creator use only the saved knowledge base.
        </p>
        {error && errorSource !== 'save' && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger text-danger-foreground px-4 py-3 mb-4 text-sm" role="alert">
            <span className="min-w-0 flex-1">{error}</span>
            {errorSource === 'opening' && <Button variant="outline" onClick={() => {
              setError('');
              openingStarted.current = false;
              setOpeningAttempt(attempt => attempt + 1);
            }} disabled={isBusy} focusableWhenDisabled>Retry conversation</Button>}
            <button type="button" onClick={() => setError('')} aria-label="Dismiss error" className={DISMISS_CLASS}>&times;</button>
          </div>
        )}
        {draftWarning && <p className="text-sm text-warning-foreground mb-4" role="status">{draftWarning}</p>}

        <div className="knowledge-workspace">
          <div className="min-w-0">
            <TabsContent value="conversation">
              <div className="mb-4 space-y-2">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">Assistant readiness</span>
                  <span className="text-muted-foreground tabular-nums">{readiness}/10</span>
                </div>
                <div role="progressbar" aria-valuemin={0} aria-valuemax={10} aria-valuenow={readiness}
                  aria-label={`Knowledge base readiness: ${readiness} out of 10`} aria-describedby="kb-readiness-hint"
                  className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="progress-fill h-full rounded-full" style={{ transform: `scaleX(${readiness / 10})`, backgroundColor: readinessFill(readiness) }} />
                </div>
                <p id="kb-readiness-hint" className="text-sm text-muted-foreground">
                  The assistant estimates how much program detail it has. At least 3/10 is needed to generate a preview.
                  You decide whether the document is ready to save. Text editing does not need a readiness score.
                </p>
              </div>
              <ChatArea announcement={srAnnouncement}>
                {chatMessages.map(renderMessage)}
                {displayText != null && displayText.length > 0 && <AssistantMessage content={displayText} streaming />}
                {busy === 'starting' && !displayText && <ThinkingSpinner text="Starting..." />}
                {busy === 'qa' && !displayText && <ThinkingSpinner />}
              </ChatArea>
              <ComposeBar placeholder="Tell me about your program..." storageKey={storageKey} onSend={handleSend} busy={isBusy} />
            </TabsContent>
            <TabsContent value="text" className="space-y-3">
              <Label htmlFor="kb-document-text">Knowledge base text</Label>
              <p id="kb-text-hint" className="text-sm text-muted-foreground">
                Write or paste your program reference in Markdown. Review text changes to put this exact text in the preview.
                Conversation suggestions are included only if you add them here or refresh from Conversation.
              </p>
              <Textarea id="kb-document-text" value={draftMarkdown} readOnly={isBusy} aria-describedby="kb-text-hint kb-text-review-hint"
                className="knowledge-text-input" onChange={event => { setDraftMarkdown(event.target.value); setError(''); setErrorSource(''); }} />
              <p id="kb-text-review-hint" className="text-sm text-muted-foreground">
                {!savableKnowledgeBase(draftMarkdown, savedMarkdown)
                  ? 'Add at least 50 characters of program detail before reviewing.'
                  : unreviewedText || !editor.previewCurrent ? 'Your text changes have not been reviewed yet.' : 'This text matches the preview.'}
              </p>
              <Button onClick={reviewText} disabled={isBusy || !savableKnowledgeBase(draftMarkdown, savedMarkdown) || editor.previewCurrent} focusableWhenDisabled>
                Review text changes
              </Button>
            </TabsContent>
          </div>
          <div ref={previewRegion} tabIndex={-1} className="knowledge-review min-w-0" aria-label="Review knowledge base">
            <MarkdownPreviewPane
              markdown={previewMarkdown}
              loading={previewLoading}
              error={previewError}
              stale={editor.previewStale}
              staleHint={unreviewedText ? 'The text draft has changed. Review text changes, or refresh from Conversation to combine your edits with its suggestions.' : undefined}
              saveLabel={saveLabel}
              saved={editor.saved}
              saveHint={editor.saved ? 'This is the saved knowledge base. Edit it using either method, then review the preview.' : undefined}
              refreshDisabled={isBusy || generationBlocked}
              onRefresh={mode === 'conversation' ? handleRefreshPreview : undefined}
              title="Knowledge base preview"
              ariaLabel="Knowledge base markdown preview"
              noun="knowledge base"
              preserveContent
              emptyHint="Use Conversation to generate a preview, or write in Edit text and review your changes."
            />
          </div>
        </div>
        <div className="knowledge-save-actions mt-5 space-y-3 border-t border-border pt-4">
          {error && errorSource === 'save' && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p id="kb-save-hint" role="status" className="text-sm text-muted-foreground min-w-0 flex-1">
              {busy === 'saving' ? 'Saving your reviewed document…'
                : editor.saved ? 'No unsaved changes.'
                  : !editor.previewCurrent ? 'Review the current preview before saving.'
                    : 'Saves exactly this preview.'}
            </p>
            <Button onClick={handleSaveKB} disabled={isBusy || saveBlocked} focusableWhenDisabled aria-describedby="kb-save-hint">
              {busy === 'saving' || busy === 'saved' ? 'Saving...' : errorSource === 'save' && error ? 'Retry saving' : saveLabel}
            </Button>
          </div>
        </div>
      </Tabs>
      <AlertDialog open={blocker.state === 'blocked'} onOpenChange={open => { if (!open) blocker.reset?.(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              {editor.leaveGuard === 'saving' ? 'Your knowledge base is still saving. Stay here until the save finishes.'
                : editor.leaveGuard === 'working' ? 'The assistant is still working. Leaving keeps the last saved knowledge base.'
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
