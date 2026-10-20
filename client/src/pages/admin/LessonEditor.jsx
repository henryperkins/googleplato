import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { adminApi } from './adminApi.js';
import MarkdownPreviewPane from './MarkdownPreviewPane.jsx';
import ConfirmModal from '../../components/modals/ConfirmModal.jsx';
import ChatArea from '../../components/chat/ChatArea.jsx';
import ComposeBar from '../../components/chat/ComposeBar.jsx';
import AssistantMessage from '../../components/chat/AssistantMessage.jsx';
import UserMessage from '../../components/chat/UserMessage.jsx';
import ThinkingSpinner from '../../components/chat/ThinkingSpinner.jsx';
import { converseStream, extractLessonMarkdown } from '../../../js/orchestrator.js';
import { parseLessonPrompt } from '../../../js/lessonOwner.js';
import { parseResponse, cleanStream, buildConversationText, lessonObjectiveError } from '../../lib/lessonCreationEngine.js';
import { createLessonSaveQueue, lessonRecoveryKey } from '../../lib/lessonSaveQueue.js';
import { useStreamedText } from '../../hooks/useStreamedText.js';
import { useTitleNotification } from '../../hooks/useTitleNotification.js';
import { MSG_TYPES, MIN_OBJECTIVES, MAX_OBJECTIVES } from '../../lib/constants.js';
import { readinessFill } from '../../lib/readiness.js';
import { aiErrorMessage } from '../../lib/aiErrors.js';

const actionClass = 'h-auto min-h-9 max-w-full whitespace-normal py-2';

export default function LessonEditor({ lessonId, userId, isDraft, initialMessages, initialReadiness,
  needsAgentReply, initialCourse, initialMarkdown, conversationRevision, markdownRevision,
  version, operationId, recovery, onSave, onCancel, onReload }) {
  const pageTitle = isDraft ? 'New Lesson — plato' : 'Edit Lesson — plato';
  useEffect(() => { document.title = pageTitle; }, [pageTitle]);
  const notifyTitle = useTitleNotification(pageTitle);
  const [queue] = useState(() => {
    let storage;
    try { storage = window.sessionStorage; } catch { /* The queue reports unavailable recovery storage. */ }
    return createLessonSaveQueue({
      write: body => adminApi('PUT', `/v1/admin/lessons/${encodeURIComponent(lessonId)}`, body),
      storage, storageKey: lessonRecoveryKey(userId, lessonId), version, operationId, recovery,
      snapshot: {
        conversation: initialMessages || [], readiness: initialReadiness ?? 0, course: initialCourse || '',
        revision: conversationRevision || 0, previewMarkdown: initialMarkdown || '',
        previewRevision: initialMarkdown ? (markdownRevision || 0) : -1,
        failedReply: !needsAgentReply && initialMessages?.at(-1)?.role === 'user' ? 'reply' : null,
        finalizePending: false,
      },
    });
  });
  const [saveState, setSaveState] = useState(queue.getState);
  const snapshot = saveState.snapshot;
  const [courses, setCourses] = useState([]);
  const [busy, setBusy] = useState('');
  const busyRef = useRef('');
  const [error, setError] = useState('');
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewRequest = useRef(0);
  const epoch = useRef(0);
  const composerEnd = useRef(null);
  const previewRef = useRef(null);
  const [streamingText, setStreamingText] = useState(null);
  const displayText = useStreamedText(streamingText);
  const [draining, setDraining] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const update = useCallback((patch, { save = false, content = false } = {}) => {
    const previous = queue.getState().snapshot;
    const next = { ...previous, ...patch, revision: content ? crypto.randomUUID() : previous.revision };
    queue.remember(next);
    if (save) queue.enqueue({
      ...(isDraft ? { status: 'draft', name: 'Untitled draft' } : {}),
      conversation: next.conversation, readiness: next.readiness, course: next.course || null,
      conversationRevision: next.revision,
    });
    return next;
  }, [queue, isDraft]);

  const requestReply = useCallback(async (opening = false) => {
    if (busyRef.current || queue.getState().error?.status === 409) return;
    const generation = epoch.current;
    busyRef.current = opening ? 'starting' : 'reply';
    setBusy(busyRef.current);
    setError('');
    setStreamingText('');
    const current = update({ failedReply: opening ? 'opening' : 'reply' });
    const messages = current.conversation.length
      ? current.conversation.slice(-15).map(({ role, content }) => ({ role, content }))
      : [{ role: 'user', content: 'I want to create a new lesson.' }];
    try {
      const raw = await converseStream('lesson-creator', messages,
        cleanStream(partial => { if (epoch.current === generation) setStreamingText(partial); }), 512);
      if (epoch.current !== generation) return;
      const { text, readiness } = parseResponse(raw);
      if (!text?.trim()) throw new Error('The reply was empty. Retry the reply.');
      // Persist the complete response before its visual typing animation drains.
      setDraining(true);
      update({
        conversation: [...queue.getState().snapshot.conversation,
          { role: 'assistant', content: text, msgType: MSG_TYPES.GUIDE }],
        readiness: readiness ?? current.readiness, failedReply: null,
      }, { save: true, content: !opening || !initialMarkdown });
      setStreamingText(null);
      notifyTitle();
    } catch (failure) {
      if (epoch.current !== generation) return;
      setError(aiErrorMessage(failure, 'lesson-creator'));
      setStreamingText(null);
      busyRef.current = '';
      setBusy('');
    }
  }, [queue, update, notifyTitle, initialMarkdown]);

  useEffect(() => {
    const unsubscribe = queue.subscribe(setSaveState);
    const beforeUnload = event => {
      const current = queue.getState();
      if (current.pending || current.localError) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    // Deferring startup avoids duplicate requests during StrictMode's effect probe.
    const start = setTimeout(() => {
      void queue.flush().catch(() => {});
      const current = queue.getState().snapshot;
      if (!current.failedReply && !current.finalizePending
        && (!current.conversation.length || (needsAgentReply && !recovery))) void requestReply(true);
    }, 0);
    const invalidateRequests = () => { epoch.current++; previewRequest.current++; };
    return () => {
      clearTimeout(start);
      unsubscribe();
      queue.pause();
      invalidateRequests();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [queue, requestReply, needsAgentReply, recovery]);

  useEffect(() => {
    let cancelled = false;
    adminApi('GET', '/v1/admin/courses').then(data => {
      if (!cancelled) setCourses(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (!cancelled) setError('Courses could not be loaded. Your current course is unchanged.');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (displayText === null && draining) {
      setDraining(false);
      busyRef.current = '';
      setBusy('');
      setAnnouncement(`Reply received. ${snapshot.conversation.length} messages in the conversation.`);
    }
  }, [displayText, draining, snapshot.conversation.length]);

  const blocked = !!busy || snapshot.finalizePending || saveState.error?.status === 409;
  const previewCurrent = !!snapshot.previewMarkdown && snapshot.previewRevision === snapshot.revision;
  const previewSaved = !isDraft && snapshot.previewMarkdown === initialMarkdown;
  const saveRejected = saveState.error?.status === 400 && snapshot.finalizePending;
  const chatMessages = draining ? snapshot.conversation.slice(0, -1) : snapshot.conversation;
  const saveLabel = isDraft ? 'Create Lesson' : 'Update Lesson';
  const previewAction = snapshot.previewMarkdown ? 'Refresh preview' : 'Generate preview';
  const previewSaveHint = snapshot.finalizePending
    ? (busy === 'saving' ? 'Saving this lesson…'
      : saveState.error?.status === 400 ? 'This preview could not be saved. Choose “Revise lesson” to make changes.'
        : 'Saving is not confirmed. “Retry saving lesson” saves this same preview.')
    : previewSaved ? 'This is the saved lesson. Describe any changes in the conversation, then refresh the preview.'
      : isDraft ? 'Review this preview, then choose “Create Lesson”. Your new lesson starts private.'
        : 'Review this preview, then choose “Update Lesson” to save your changes.';

  function handleSend({ text }) {
    if (!text?.trim() || busyRef.current || blocked || snapshot.failedReply) return;
    update({ conversation: [...queue.getState().snapshot.conversation,
      { role: 'user', content: text, msgType: MSG_TYPES.USER }] }, { save: true, content: true });
    void requestReply();
  }

  async function refreshPreview() {
    if (previewLoading || blocked || !snapshot.conversation.length) return;
    const request = ++previewRequest.current;
    const current = queue.getState().snapshot;
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const markdown = await extractLessonMarkdown(buildConversationText(current.conversation));
      if (request !== previewRequest.current) return;
      const lesson = parseLessonPrompt(lessonId, markdown);
      const objectiveError = lessonObjectiveError(markdown);
      if (objectiveError) throw new Error(objectiveError);
      if (!lesson.name || !lesson.exemplar || lesson.learningObjectives.length < MIN_OBJECTIVES
        || lesson.learningObjectives.length > MAX_OBJECTIVES) {
        throw new Error(`The preview needs a title, exemplar and ${MIN_OBJECTIVES}–${MAX_OBJECTIVES} learning objectives. Keep refining the lesson, then generate it again.`);
      }
      update({ previewMarkdown: markdown, previewRevision: current.revision });
      previewRef.current?.focus();
      previewRef.current?.scrollIntoView({ block: 'nearest' });
    } catch (failure) {
      if (request === previewRequest.current) setPreviewError(aiErrorMessage(failure, 'preview'));
    } finally {
      if (request === previewRequest.current) setPreviewLoading(false);
    }
  }

  async function retrySaving() {
    if (busyRef.current) return;
    const generation = epoch.current;
    busyRef.current = 'saving';
    setBusy('saving');
    try {
      await queue.flush();
      if (generation !== epoch.current) return;
      if (queue.getState().snapshot.finalizePending) {
        queue.clear();
        await onSave();
      }
    } catch { /* The persistent save status owns the recovery action. */ }
    finally { busyRef.current = ''; setBusy(''); }
  }

  async function handleSave() {
    if (busyRef.current || previewLoading || saveState.error?.status === 409) return;
    if (snapshot.finalizePending) { await retrySaving(); return; }
    if (!previewCurrent) { await refreshPreview(); return; }
    busyRef.current = 'saving';
    setBusy('saving');
    setError('');
    const generation = epoch.current;
    try {
      await queue.flush();
      if (generation !== epoch.current) return;
      const current = queue.getState().snapshot;
      const lesson = parseLessonPrompt(lessonId, current.previewMarkdown);
      update({ finalizePending: true });
      await queue.save({
        markdown: current.previewMarkdown, name: lesson.name, conversation: current.conversation,
        readiness: current.readiness, course: current.course || null,
        conversationRevision: current.revision, markdownRevision: current.previewRevision,
        ...(isDraft ? { status: 'private', sharedWith: [userId] } : {}),
      });
      if (generation !== epoch.current) return;
      queue.clear();
      await onSave();
    } catch { /* Keep the exact preview and pending write for persistence-only retry. */ }
    finally { busyRef.current = ''; setBusy(''); }
  }

  async function goBack() {
    const generation = epoch.current;
    try {
      await queue.flush();
      if (generation !== epoch.current) return;
      await onCancel();
    } catch { /* Stay with the recovery controls if leaving would lose a save. */ }
  }

  function restart() {
    epoch.current++;
    previewRequest.current++;
    setPreviewLoading(false);
    setPreviewError('');
    setError('');
    update({ conversation: [], readiness: 0, previewMarkdown: '', previewRevision: -1, failedReply: null },
      { save: true, content: true });
    void requestReply(true);
  }

  const statusText = saveState.error
    ? (saveState.error.status === 409 || saveState.error.status === 400 ? saveState.error.message
      : `Saving is not confirmed. ${saveState.localError ? 'Keep this page open and retry saving.' : 'Your work is kept in this tab. Retry saving before closing it.'}`)
    : saveState.saving ? (snapshot.finalizePending ? 'Saving lesson…' : 'Saving conversation and course…')
      : saveState.localError ? 'A backup is unavailable in this tab. Check that changes are saved before leaving.'
        : saveState.version ? 'Conversation and course saved automatically.' : 'Conversation not saved yet.';

  return (
    <div className="lesson-editor min-w-0">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Button variant="ghost" size="sm" className={actionClass} onClick={goBack} aria-label="Back to lessons">&larr; Back</Button>
        <h1 className="text-2xl font-bold">{isDraft ? 'New Lesson' : 'Edit Lesson'}</h1>
      </div>
      {error && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-danger-border bg-danger text-danger-foreground px-4 py-3 mb-4 text-sm" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <Button variant="ghost" size="icon" onClick={() => setError('')} aria-label="Dismiss error">&times;</Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <p className={`text-sm ${saveState.error || saveState.localError ? 'text-warning-foreground' : 'text-muted-foreground'}`} role="status">{statusText}</p>
        {saveState.error && !saveRejected && (saveState.error.status === 409
          ? <Button variant="outline" size="sm" className={actionClass} onClick={() => setConfirmReload(true)}>Load saved lesson</Button>
          : <Button variant="outline" size="sm" className={actionClass} disabled={!!busy} focusableWhenDisabled onClick={retrySaving}>Retry saving</Button>)}
      </div>
      <div className="flex flex-wrap items-center gap-3 min-w-0 mb-4">
        <label htmlFor="lesson-course" className="text-sm font-medium">Course <span className="font-normal text-muted-foreground">(optional)</span></label>
        <select id="lesson-course" value={snapshot.course}
          aria-disabled={blocked}
          onChange={event => { if (!blocked) update({ course: event.target.value }, { save: true }); }}
          className="min-h-10 min-w-0 max-w-full flex-1 sm:flex-initial truncate rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <option value="">No course</option>
          {snapshot.course && !courses.some(course => course.courseId === snapshot.course)
            && <option value={snapshot.course}>Current course</option>}
          {courses.map(course => <option key={course.courseId} value={course.courseId}>{course.name}</option>)}
        </select>
      </div>
      <div className="lesson-editor-actions admin-sticky-bar sticky top-0 z-20 -mx-1 px-1 py-2 bg-background flex flex-wrap items-center gap-3 mb-4">
        <div className="flex-[1_1_10rem] min-w-0" role="progressbar" aria-valuemin={0} aria-valuemax={10}
          aria-valuenow={snapshot.readiness} aria-label={`Lesson readiness: ${snapshot.readiness} out of 10`}>
          <div className="flex flex-wrap justify-between gap-x-3 text-sm text-muted-foreground mb-2" aria-hidden="true">
            <span>Lesson readiness</span><span className="tabular-nums">{snapshot.readiness}/10</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="progress-fill h-full rounded-full" style={{ transform: `scaleX(${snapshot.readiness / 10})`, backgroundColor: readinessFill(snapshot.readiness) }} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
          <Button variant="outline" size="sm" className={actionClass} onClick={() => setConfirmRestart(true)} disabled={blocked} focusableWhenDisabled>Start over</Button>
          <Button size="sm" className={actionClass} onClick={saveRejected ? () => {
            if (queue.discardRejected()) update({ finalizePending: false, previewRevision: -1 });
          } : handleSave} focusableWhenDisabled
            disabled={!!busy || previewLoading || saveState.error?.status === 409 || !!snapshot.failedReply
              || (!previewCurrent && !snapshot.conversation.length) || (isDraft && previewCurrent && snapshot.readiness < 3)}
            aria-describedby={isDraft && snapshot.readiness < 3 ? 'create-lesson-hint' : undefined}>
            {busy === 'saving' ? 'Saving…' : saveRejected ? 'Revise lesson' : snapshot.finalizePending ? 'Retry saving lesson'
              : previewLoading ? (snapshot.previewMarkdown ? 'Refreshing preview…' : 'Generating preview…')
                : previewCurrent ? saveLabel : previewAction}
          </Button>
        </div>
        {isDraft && snapshot.readiness < 3 && <p id="create-lesson-hint" className="basis-full text-sm text-muted-foreground">Keep refining the lesson in the conversation. You can create it once readiness reaches 3/10.</p>}
      </div>
      <ConfirmModal open={confirmRestart} onOpenChange={setConfirmRestart} title="Start over?"
        message="This clears the conversation, preview and readiness score. It cannot be undone."
        confirmLabel="Start over" onConfirm={restart} />
      <ConfirmModal open={confirmReload} onOpenChange={setConfirmReload} title="Load the saved lesson?"
        message="This discards this tab’s unsaved conversation and preview and loads the latest saved lesson."
        confirmLabel="Discard local changes" onConfirm={() => { queue.clear(); onReload(); }} />
      <div className="flex flex-wrap gap-4">
        <div className="flex-[3_1_28rem] min-w-0">
          <div className="lesson-editor-chat rounded-2xl bg-muted/40 p-2 sm:p-4">
            <div className="mb-3">
              <ChatArea announcement={announcement} scrollTargetRef={composerEnd}>
                {chatMessages.map((message, index) => message.role === 'user'
                  ? <UserMessage key={index} content={message.content} />
                  : <AssistantMessage key={index} content={message.content} />)}
                {displayText != null && displayText.length > 0 && <AssistantMessage content={displayText} streaming />}
                {(busy === 'starting' || busy === 'reply') && !displayText && <ThinkingSpinner text={busy === 'starting' ? 'Starting the lesson conversation…' : undefined} />}
              </ChatArea>
            </div>
            {snapshot.failedReply && !busy && (
              <div className="flex flex-wrap items-center gap-2 mb-3 px-4">
                <p className="text-sm text-muted-foreground">{snapshot.failedReply === 'opening'
                  ? 'The conversation could not start. Try again when you’re ready.'
                  : 'The reply did not finish. Your message is still in the conversation.'}</p>
                <Button variant="outline" size="sm" className={actionClass} disabled={blocked} onClick={() => requestReply(snapshot.failedReply === 'opening')}>Retry reply</Button>
              </div>
            )}
            <ComposeBar className="lesson-editor-composer" placeholder="Describe what you want to teach..."
              storageKey={`plato_lesson_editor_draft:${userId}:${lessonId}`}
              onSend={handleSend} busy={blocked || !!snapshot.failedReply} />
            <div ref={composerEnd} />
          </div>
        </div>
        <div className="flex-[2_1_22rem] min-w-0" ref={previewRef} tabIndex={-1} aria-label="Lesson preview">
          <MarkdownPreviewPane markdown={snapshot.previewMarkdown} loading={previewLoading} error={previewError}
            stale={!!snapshot.previewMarkdown && !previewCurrent} saveLabel={saveLabel}
            saved={previewSaved && !snapshot.finalizePending} saveHint={previewSaveHint}
            refreshDisabled={previewLoading || blocked || !!snapshot.failedReply || !snapshot.conversation.length}
            onRefresh={refreshPreview} />
        </div>
      </div>
    </div>
  );
}
