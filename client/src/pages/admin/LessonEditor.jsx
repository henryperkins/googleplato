import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, Globe, LockKeyhole, RotateCcw, X } from 'lucide-react';
import { adminApi } from './adminApi.js';
import MarkdownPreviewPane from './MarkdownPreviewPane.jsx';
import ConfirmModal from '../../components/modals/ConfirmModal.jsx';
import ShareLessonModal from '../../components/modals/ShareLessonModal.jsx';
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

const actionClass = 'h-auto min-h-9 max-w-full whitespace-normal py-2 text-sm';
const NO_USERS = [];

export default function LessonEditor({ lessonId, userId, isDraft, initialMessages, initialReadiness,
  needsAgentReply, initialCourse, initialMarkdown, conversationRevision, markdownRevision,
  initialStatus = 'private', initialSharedWith = NO_USERS,
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
  const previewTrigger = useRef(null);
  const [streamingText, setStreamingText] = useState(null);
  const displayText = useStreamedText(streamingText);
  const [draining, setDraining] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [visibility, setVisibility] = useState(initialStatus);
  const [sharedWith, setSharedWith] = useState(initialSharedWith);
  const [shareOpen, setShareOpen] = useState(false);
  const editorRef = useRef(null);
  const tabsRef = useRef(null);
  const lastFocusedControl = useRef(null);
  const focusAfterLayout = useRef(null);
  const readinessRef = useRef(null);
  const [compact, setCompact] = useState(false);
  const [activePane, setActivePane] = useState(snapshot.finalizePending ? 'preview' : 'refine');
  const [readinessOpen, setReadinessOpen] = useState(false);

  // Follow the container breakpoint, including enlarged text and the sidebar.
  // Keep both panels mounted so drafts and in-flight replies survive tab changes.
  useLayoutEffect(() => {
    let previousNarrow;
    const measure = () => {
      const narrow = getComputedStyle(tabsRef.current).display !== 'none';
      if (narrow === previousNarrow) return;
      previousNarrow = narrow;
      // CSS can hide and blur a mobile control before ResizeObserver runs.
      const active = document.activeElement;
      const focused = editorRef.current.contains(active) ? active
        : active === document.body ? lastFocusedControl.current : null;
      if (narrow && focused) {
        if (focused.closest('#lesson-preview-panel')) setActivePane('preview');
        else if (focused.closest('#lesson-refine-panel')) setActivePane('refine');
        if (focused.closest('.lesson-editor-readiness')) setReadinessOpen(true);
      } else if (focused) {
        let target;
        if (tabsRef.current.contains(focused)) {
          target = focused.getAttribute('aria-controls') === 'lesson-refine-panel'
            ? document.getElementById('lesson-refine-heading') : previewRef.current;
        } else if (focused.matches('.lesson-editor-readiness-toggle')) target = readinessRef.current;
        else if (focused.matches('.lesson-editor-view-preview')) target = previewRef.current;
        if (target) focusAfterLayout.current = { from: focused, target };
      }
      setCompact(narrow);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(editorRef.current);
    observer.observe(tabsRef.current);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const pending = focusAfterLayout.current;
    focusAfterLayout.current = null;
    if (pending?.target.getClientRects().length
      && (document.activeElement === document.body || document.activeElement === pending.from)) {
      pending.target.focus({ preventScroll: true });
    }
  }, [compact]);

  useEffect(() => {
    if (!previewError) return;
    const trigger = previewTrigger.current;
    previewTrigger.current = null;
    // Reveal the result of the active refresh without taking focus or moving
    // a different panel the author switched to while the request was pending.
    if (trigger === document.activeElement && previewRef.current?.getClientRects().length
      && previewRef.current.parentElement.contains(trigger)) {
      previewRef.current.querySelector('[role="alert"]')?.scrollIntoView({ block: 'nearest' });
    }
  }, [previewError]);

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

  // Run after the queue acknowledges a visibility save, including recovery.
  const confirmVisibility = useCallback(() => {
    const current = queue.getState();
    if (!current.snapshot.visibilityPending || current.pending || current.error) return;
    const confirmed = current.snapshot.visibilityPending;
    setVisibility(confirmed.status);
    setSharedWith(confirmed.sharedWith);
    update({ visibilityPending: null });
    setShareOpen(false);
    setError('');
    setAnnouncement(confirmed.status === 'public' ? 'Lesson is now public.' : 'Lesson visibility and sharing saved.');
  }, [queue, update]);

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
      const generation = epoch.current;
      void queue.flush().then(() => {
        if (generation === epoch.current) confirmVisibility();
      }).catch(() => {});
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
  }, [queue, requestReply, needsAgentReply, recovery, confirmVisibility]);

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

  const blocked = !!busy || snapshot.finalizePending || !!snapshot.visibilityPending || saveState.error?.status === 409;
  const previewCurrent = !!snapshot.previewMarkdown && snapshot.previewRevision === snapshot.revision;
  const previewSaved = !isDraft && snapshot.previewMarkdown === initialMarkdown;
  const saveRejected = saveState.error?.status === 400 && snapshot.finalizePending;
  const chatMessages = draining ? snapshot.conversation.slice(0, -1) : snapshot.conversation;
  const saveLabel = isDraft || visibility !== 'public' ? 'Save privately' : 'Update lesson';
  const publishing = snapshot.finalizePending && snapshot.finalizeStatus === 'public';
  const showPublish = !saveRejected && (publishing || (visibility !== 'public' && !!snapshot.previewMarkdown && !snapshot.finalizePending));
  const saveDisabled = !!busy || previewLoading || saveState.error?.status === 409 || !!snapshot.failedReply
    || !!snapshot.visibilityPending || (!previewCurrent && !snapshot.finalizePending)
    || (isDraft && snapshot.readiness < 3 && !snapshot.finalizePending);
  const previewAction = snapshot.previewMarkdown ? 'Refresh preview' : 'Generate preview';
  const needsPreview = !previewCurrent && !snapshot.finalizePending;
  const previewDisabled = previewLoading || blocked || !!snapshot.failedReply || !snapshot.conversation.length;
  const previewStatus = snapshot.finalizePending ? 'Lesson save not confirmed'
    : previewSaved ? 'Currently saved content'
      : previewCurrent ? (isDraft ? 'Preview current · Not saved as a lesson' : 'Preview current · Changes not applied')
        : 'Previous preview · Changes not applied';
  const previewSaveHint = snapshot.finalizePending
    ? (busy === 'saving' ? 'Saving this lesson…'
      : saveState.error?.status === 400 ? 'This preview could not be saved. Choose “Revise lesson” to make changes.'
        : 'Saving is not confirmed. “Retry saving lesson” saves this same preview and visibility choice.')
    : !previewCurrent ? (visibility === 'public' ? 'Refresh, review, then update the public lesson.'
      : snapshot.previewMarkdown ? 'Refresh the preview and review it before saving the lesson.'
        : 'Generate a preview and review it before saving the lesson.')
      : previewSaved ? 'This is the saved lesson. Describe any changes in the conversation, then refresh the preview.'
      : visibility !== 'public' ? 'Review this preview, then choose “Save privately” or “Save & make public”.'
        : 'Review this preview, then choose “Update lesson” to save your changes.';

  function handleSend({ text }) {
    if (!text?.trim() || busyRef.current || blocked || snapshot.failedReply) return;
    update({ conversation: [...queue.getState().snapshot.conversation,
      { role: 'user', content: text, msgType: MSG_TYPES.USER }] }, { save: true, content: true });
    void requestReply();
  }

  async function refreshPreview() {
    if (previewLoading || blocked || !snapshot.conversation.length) return;
    const request = ++previewRequest.current;
    previewTrigger.current = document.activeElement;
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
      // A refresh finishing in the background must not pull focus out of Refine.
      if (previewRef.current?.getClientRects().length
        && previewRef.current.parentElement.contains(document.activeElement)) {
        previewRef.current.focus();
        previewRef.current.scrollIntoView({ block: 'nearest' });
      }
      previewTrigger.current = null;
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
      confirmVisibility();
      if (queue.getState().snapshot.finalizePending) {
        queue.clear();
        await onSave({ status: queue.getState().snapshot.finalizeStatus || visibility });
      }
    } catch { /* The persistent save status owns the recovery action. */ }
    finally { busyRef.current = ''; setBusy(''); }
  }

  async function handleSave(status = visibility) {
    if (busyRef.current || saveDisabled) return;
    if (snapshot.finalizePending) { await retrySaving(); return; }
    if (!previewCurrent) return;
    busyRef.current = 'saving';
    setBusy('saving');
    setError('');
    const generation = epoch.current;
    try {
      await queue.flush();
      if (generation !== epoch.current) return;
      const current = queue.getState().snapshot;
      const lesson = parseLessonPrompt(lessonId, current.previewMarkdown);
      const finalStatus = status === 'public' ? 'public' : 'private';
      update({ finalizePending: true, finalizeStatus: finalStatus });
      await queue.save({
        markdown: current.previewMarkdown, name: lesson.name, conversation: current.conversation,
        readiness: current.readiness, course: current.course || null,
        conversationRevision: current.revision, markdownRevision: current.previewRevision,
        status: finalStatus,
        ...(isDraft ? { sharedWith: [userId] } : {}),
      });
      if (generation !== epoch.current) return;
      queue.clear();
      await onSave({ status: finalStatus });
    } catch { /* Keep the exact preview and pending write for persistence-only retry. */ }
    finally { busyRef.current = ''; setBusy(''); }
  }

  async function saveVisibility(choice) {
    if (busyRef.current || snapshot.finalizePending || saveState.error?.status === 409) return;
    const generation = epoch.current;
    busyRef.current = 'visibility';
    setBusy('visibility');
    setError('');
    try {
      // Keep the original pending choice after an unknown outcome.
      if (queue.getState().snapshot.visibilityPending) {
        await queue.flush();
        if (generation === epoch.current) confirmVisibility();
        return;
      }
      await queue.flush();
      if (generation !== epoch.current) return;
      update({ visibilityPending: choice });
      await queue.save(choice);
      if (generation === epoch.current) confirmVisibility();
    } catch (failure) {
      if (generation !== epoch.current) return;
      if (queue.discardRejected()) update({ visibilityPending: null });
      throw failure;
    } finally { busyRef.current = ''; setBusy(''); }
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
    setActivePane('refine');
    update({ conversation: [], readiness: 0, previewMarkdown: '', previewRevision: -1, failedReply: null },
      { save: true, content: true });
    void requestReply(true);
  }

  const statusText = saveState.error
    ? (saveState.error.status === 409 || saveState.error.status === 400 ? saveState.error.message
      : `Saving is not confirmed. ${saveState.localError ? 'Keep this page open and retry saving.' : 'Your work is kept in this tab. Retry saving before closing it.'}`)
    : saveState.saving ? (snapshot.finalizePending ? 'Saving lesson…' : snapshot.visibilityPending ? 'Saving visibility…' : 'Saving conversation and course…')
      : saveState.localError ? 'A backup is unavailable in this tab. Check that changes are saved before leaving.'
        : saveState.version ? 'Conversation and course saved automatically.' : 'Conversation not saved yet.';

  return (
    <div ref={editorRef} className="lesson-editor min-w-0"
      onFocusCapture={event => { lastFocusedControl.current = event.target; }}
      onBlurCapture={event => {
        // An ordinary blur should not restore focus later; preserve only a
        // control that the responsive layout has just hidden.
        if (event.target.getClientRects().length) lastFocusedControl.current = null;
      }}>
      <Button variant="ghost" size="sm" className={`${actionClass} mb-3 px-0`} onClick={goBack} aria-label="Back to lessons">
        <ArrowLeft className="size-4" aria-hidden="true" /> Lessons
      </Button>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h1 className="lesson-editor-title font-bold text-balance">{isDraft ? 'New Lesson' : 'Edit Lesson'}</h1>
        {isDraft ? <Badge variant="outline">Draft</Badge> : (
          <Button variant="outline" size="sm" className={actionClass}
            aria-label={`Visibility and sharing: ${visibility === 'public' ? 'Public' : 'Private'}`}
            aria-haspopup="dialog" aria-expanded={shareOpen}
            disabled={!!busy || snapshot.finalizePending || saveState.error?.status === 409} focusableWhenDisabled
            onClick={() => setShareOpen(true)}>
            {visibility === 'public' ? <Globe aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
            {visibility === 'public' ? 'Public' : 'Private'} <ChevronDown aria-hidden="true" />
          </Button>
        )}
        {!isDraft && visibility === 'public' && <p className="text-xs text-muted-foreground">Visible to all learners in this classroom.</p>}
      </div>
      {error && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-danger-border bg-danger text-danger-foreground px-4 py-3 mb-4 text-sm" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <Button variant="ghost" size="icon" onClick={() => setError('')} aria-label="Dismiss error"><X aria-hidden="true" /></Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <p className={`flex items-start gap-2 text-sm ${saveState.error || saveState.localError ? 'text-warning-foreground' : 'text-muted-foreground'}`} role="status">
          {saveState.version > 0 && !saveState.saving && !saveState.pending && !saveState.error && !saveState.localError
            && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden="true" />}
          {statusText}
        </p>
        {saveState.error && !saveRejected && (saveState.error.status === 409
          ? <Button variant="outline" size="sm" className={actionClass} onClick={() => setConfirmReload(true)}>Load saved lesson</Button>
          : <Button variant="outline" size="sm" className={actionClass} disabled={!!busy} focusableWhenDisabled onClick={retrySaving}>Retry saving</Button>)}
      </div>
      <div ref={tabsRef} className="lesson-editor-tabs" role="tablist" aria-label="Lesson workspace">
        {['refine', 'preview'].map(pane => (
          <button key={pane} type="button" role="tab" id={`lesson-${pane}-tab`}
            aria-controls={`lesson-${pane}-panel`} aria-selected={activePane === pane}
            tabIndex={activePane === pane ? 0 : -1}
            onClick={() => setActivePane(pane)}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 'refine' : event.key === 'End' ? 'preview'
                : pane === 'refine' ? 'preview' : 'refine';
              setActivePane(next);
              document.getElementById(`lesson-${next}-tab`)?.focus();
            }}>
            {pane === 'refine' ? 'Refine' : 'Preview'}
          </button>
        ))}
      </div>
      <div className="lesson-editor-columns lesson-editor-workspace">
        <section id="lesson-refine-panel" className="lesson-editor-refine min-w-0"
          tabIndex={-1}
          role={compact ? 'tabpanel' : undefined}
          aria-labelledby={compact ? 'lesson-refine-tab' : 'lesson-refine-heading'}
          hidden={compact && activePane !== 'refine'}>
          <div className="lesson-editor-columns lesson-editor-setup">
            <div className="flex flex-wrap items-center gap-3 min-w-0">
              <label htmlFor="lesson-course" className="text-sm font-medium">Course <span className="font-normal text-muted-foreground">(optional)</span></label>
              <select id="lesson-course" value={snapshot.course}
                aria-disabled={blocked}
                onChange={event => { if (!blocked) update({ course: event.target.value }, { save: true }); }}
                className="min-h-10 min-w-0 max-w-full flex-1 truncate rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <option value="">No course</option>
                {snapshot.course && !courses.some(course => course.courseId === snapshot.course)
                  && <option value={snapshot.course}>Current course</option>}
                {courses.map(course => <option key={course.courseId} value={course.courseId}>{course.name}</option>)}
              </select>
            </div>
            <details className="lesson-editor-readiness min-w-0" open={!compact || readinessOpen}
              onToggle={event => { if (compact) setReadinessOpen(event.currentTarget.open); }}>
              <summary className="lesson-editor-readiness-toggle min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-sm [&::-webkit-details-marker]:hidden">
                Lesson readiness <span className="flex items-center gap-2 tabular-nums">{snapshot.readiness}/10 <ChevronDown className="size-4" aria-hidden="true" /></span>
              </summary>
              <div ref={readinessRef} tabIndex={-1} className="min-w-0" role="progressbar" aria-valuemin={0} aria-valuemax={10}
                aria-valuenow={snapshot.readiness} aria-label={`Lesson readiness: ${snapshot.readiness} out of 10`}
                aria-describedby="lesson-readiness-description">
                <div className="flex flex-wrap justify-between gap-x-3 text-sm text-muted-foreground mb-2" aria-hidden="true">
                  <span>Lesson readiness</span><span className="tabular-nums">{snapshot.readiness}/10</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="progress-fill h-full rounded-full" style={{ transform: `scaleX(${snapshot.readiness / 10})`, backgroundColor: readinessFill(snapshot.readiness) }} />
                </div>
              </div>
              <p id="lesson-readiness-description" className="mt-2 text-sm text-muted-foreground">How fully your lesson has been defined in this conversation.</p>
              <details className="group mt-1">
                <summary className="touch-target inline-flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-sm text-sm font-medium hover:text-link [&::-webkit-details-marker]:hidden">
                  About lesson readiness <ChevronDown className="size-4 group-open:rotate-180" aria-hidden="true" />
                </summary>
                <div role="region" aria-label="Readiness guidance" className="max-w-prose pb-3 text-sm text-muted-foreground">
                  <p>The authoring assistant estimates readiness from the lesson you describe:</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>A concrete outcome: what the learner will produce or demonstrate as the exemplar.</li>
                    <li>{MIN_OBJECTIVES}–{MAX_OBJECTIVES} measurable objectives that support that outcome.</li>
                    <li>Clear, aligned requirements and a focused lesson scope.</li>
                  </ul>
                  <p className="mt-2">You can create a lesson from 3/10 once its preview is ready. Always review the exemplar and objectives in the preview before saving.</p>
                </div>
              </details>
            </details>
          </div>
          <div className="lesson-editor-chat">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
              <h2 id="lesson-refine-heading" tabIndex={-1} className="text-xl font-semibold leading-7">Refine lesson</h2>
              <Button variant="ghost" size="sm" className={actionClass} onClick={() => setConfirmRestart(true)} disabled={blocked} focusableWhenDisabled><RotateCcw aria-hidden="true" /> Start over</Button>
            </div>
            <div className="mb-3">
              <ChatArea announcement={announcement} scrollTargetRef={composerEnd} scrollOnMount={false}>
                {chatMessages.map((message, index) => message.role === 'user'
                  ? <UserMessage key={index} content={message.content} />
                  : <AssistantMessage key={index} content={message.content} speakerLabel="Lesson assistant" />)}
                {displayText != null && displayText.length > 0 && <AssistantMessage content={displayText} speakerLabel="Lesson assistant" streaming />}
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
            <ComposeBar className="lesson-editor-composer" placeholder={isDraft ? 'Describe what you want to teach…' : 'Describe the change you want to make…'}
              storageKey={`plato_lesson_editor_draft:${userId}:${lessonId}`}
              onSend={handleSend} busy={blocked || !!snapshot.failedReply} />
            <p className="lesson-editor-shortcut mt-2 text-xs text-muted-foreground">Ctrl / ⌘ + Enter to send</p>
            <Button variant="outline" className="lesson-editor-view-preview mt-3 w-full" onClick={() => {
              setActivePane('preview');
              requestAnimationFrame(() => previewRef.current?.focus());
            }}>View preview <ArrowRight aria-hidden="true" /></Button>
            <div ref={composerEnd} />
          </div>
        </section>
        <section id="lesson-preview-panel" className="lesson-editor-preview min-w-0"
          tabIndex={-1}
          role={compact ? 'tabpanel' : undefined}
          aria-labelledby={compact ? 'lesson-preview-tab' : undefined}
          hidden={compact && activePane !== 'preview'}>
          <div ref={previewRef} tabIndex={-1} aria-label="Lesson preview">
            <MarkdownPreviewPane markdown={snapshot.previewMarkdown} loading={previewLoading} error={previewError}
              stale={!!snapshot.previewMarkdown && !previewCurrent} saveLabel={saveLabel}
              saved={previewSaved && !snapshot.finalizePending} saveHint={previewSaveHint}
              statusLabel={previewStatus} staleLabel="Needs refresh" preserveContent
              refreshDisabled={previewDisabled}
              onRefresh={snapshot.previewMarkdown && !snapshot.finalizePending ? refreshPreview : undefined} />
          </div>
          <div className="lesson-editor-actions mt-4 flex flex-wrap items-stretch gap-2" role="group" aria-label="Save lesson">
            {needsPreview && !snapshot.previewMarkdown && <Button size="sm" className={`${actionClass} flex-1`} onClick={refreshPreview}
              disabled={previewDisabled} focusableWhenDisabled aria-describedby="lesson-preview-save-hint">
              <RotateCcw aria-hidden="true" /> {previewLoading ? (snapshot.previewMarkdown ? 'Refreshing preview…' : 'Generating preview…') : previewAction}
            </Button>}
            {(!publishing || saveRejected) && (!!snapshot.previewMarkdown || !isDraft || snapshot.finalizePending)
              && <Button size="sm" variant={needsPreview ? 'outline' : 'default'} className={`${actionClass} flex-1`} onClick={saveRejected ? () => {
              if (queue.discardRejected()) update({ finalizePending: false, finalizeStatus: null, previewRevision: -1 });
            } : () => handleSave()} focusableWhenDisabled
              disabled={saveDisabled}
              aria-describedby={isDraft && snapshot.readiness < 3 ? 'create-lesson-hint' : 'lesson-preview-save-hint'}>
              {needsPreview && <LockKeyhole aria-hidden="true" />}
              {busy === 'saving' ? 'Saving…' : saveRejected ? 'Revise lesson' : snapshot.finalizePending ? 'Retry saving lesson'
                : saveLabel}
            </Button>}
            {showPublish && <Button variant="outline" size="sm" className={`${actionClass} flex-1`}
              onClick={() => !isDraft && previewSaved && !publishing
                ? void saveVisibility({ status: 'public', sharedWith }).catch(failure => setError(failure.message))
                : void handleSave('public')}
              disabled={saveDisabled} focusableWhenDisabled aria-describedby="publish-lesson-hint">
              {publishing ? (busy === 'saving' ? 'Saving…' : 'Retry saving lesson')
                : !isDraft && previewSaved ? 'Make public' : 'Save & make public'}
            </Button>}
            {showPublish && <p id="publish-lesson-hint" className="basis-full text-sm text-muted-foreground">Public lessons are visible to all learners in this classroom.</p>}
            <p id="lesson-preview-save-hint" className={showPublish && previewCurrent && !previewSaved && !snapshot.finalizePending
              ? 'sr-only' : 'basis-full text-sm text-muted-foreground'}>{previewSaveHint}</p>
            {isDraft && snapshot.readiness < 3 && <p id="create-lesson-hint" className="basis-full text-sm text-muted-foreground">Keep refining the lesson in the conversation. You can create it once readiness reaches 3/10.</p>}
          </div>
        </section>
      </div>
      {shareOpen && <ShareLessonModal open onOpenChange={setShareOpen}
        lessonName={parseLessonPrompt(lessonId, initialMarkdown || snapshot.previewMarkdown).name || lessonId}
        initialStatus={snapshot.visibilityPending?.status || visibility}
        initialSharedWith={snapshot.visibilityPending?.sharedWith || sharedWith}
        pendingSave={!!snapshot.visibilityPending} onConfirm={saveVisibility} />}
      <ConfirmModal open={confirmRestart} onOpenChange={setConfirmRestart} title="Start over?"
        message="This clears the conversation, preview and readiness score. It cannot be undone."
        confirmLabel="Start over" onConfirm={restart} />
      <ConfirmModal open={confirmReload} onOpenChange={setConfirmReload} title="Load the saved lesson?"
        message="This discards this tab’s unsaved conversation and preview and loads the latest saved lesson."
        confirmLabel="Discard local changes" onConfirm={() => { queue.clear(); onReload(); }} />
    </div>
  );
}
