import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { useApp } from '../contexts/AppContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useStreamedText } from '../hooks/useStreamedText.js';
import { useTitleNotification } from '../hooks/useTitleNotification.js';
import { useVisualViewportKeyboardOffset } from '../hooks/useVisualViewportKeyboardOffset.js';
import { LESSON_PHASES, MSG_TYPES } from '../lib/constants.js';
import { aiErrorMessage } from '../lib/aiErrors.js';
import {
  deleteLessonProgress,
  getUserLessonMarkdown, deleteUserLesson,
} from '../../js/storage.js';
import * as engine from '../lib/lessonEngine.js';

import ChatArea from '../components/chat/ChatArea.jsx';
import ThinkingSpinner from '../components/chat/ThinkingSpinner.jsx';
import UserMessage from '../components/chat/UserMessage.jsx';
import AssistantMessage from '../components/chat/AssistantMessage.jsx';
import ProgressBar from '../components/chat/ProgressBar.jsx';
import ComposeBar from '../components/chat/ComposeBar.jsx';
import LessonLoadingView from '../components/chat/LessonLoadingView.jsx';
import ConfirmModal from '../components/modals/ConfirmModal.jsx';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

export default function LessonChat() {
  const { lessonGroupId } = useParams();
  const { user, impersonatedUser } = useAuth();
  // Remount the conversation and its stream animation together. Setting the
  // stream to null only drains buffered text; it cannot isolate two views.
  return <LessonConversation key={`${user?.userId}:${impersonatedUser?.userId || ''}:${lessonGroupId}`} />;
}

function LessonConversation() {
  const { lessonGroupId } = useParams();
  const navigate = useNavigate();
  const { state, dispatch, reloadLessons } = useApp();
  const { lessons } = state;
  const lesson = lessons.find(c => c.lessonId === lessonGroupId);
  const { user, impersonatedUser } = useAuth();
  const impersonating = !!impersonatedUser;
  const viewKey = `${user?.userId}:${impersonatedUser?.userId || ''}:${lessonGroupId}`;
  const activeView = useRef(viewKey);
  useEffect(() => {
    activeView.current = viewKey;
    return () => { activeView.current = null; };
  }, [viewKey]);

  // The resume/start effect below must run once per lesson — NOT every time
  // the lessons array is rebuilt. Returning to the browser tab re-runs
  // `loadAll()` + `loadLessons()`, which produces a fresh `lesson` object
  // with the same contents but a new identity. Keying the effect on that
  // identity made it re-run on every tab refocus, re-fetching messages from
  // the (just-cleared) cache and resetting the conversation to its last
  // persisted state mid-lesson (issue #191). The effect reads `lesson` via
  // this ref and keys only on stable values (id + presence).
  const lessonRef = useRef(lesson);
  useEffect(() => { lessonRef.current = lesson; }, [lesson]);
  const lessonLoaded = !!lesson;

  const [phase, setPhase] = useState(null);
  const [messages, setMessages] = useState([]);
  const [lessonKB, setLessonKB] = useState(null);
  const [celebratedLessonId, setCelebratedLessonId] = useState(null);
  const [loading, setLoading] = useState('');
  const [loadingStep, setLoadingStep] = useState('initializing');
  const [loadingEnrichments, setLoadingEnrichments] = useState([]);
  const [error, setError] = useState('');
  const [persistence, setPersistence] = useState(null);
  const [resuming, setResuming] = useState(true);
  const savingRef = useRef(false);
  const pendingSave = !!persistence && persistence.status !== 'saved';
  // A failed lesson start has no conversation to fall back on, so it offers
  // its own retry instead of sending the learner to reload the page.
  const [startFailed, setStartFailed] = useState(false);
  const [startAttempt, setStartAttempt] = useState(0);
  const headingRef = useRef(null);

  const [streamingText, setStreamingText] = useState(null);
  const displayText = useStreamedText(streamingText);
  const pendingAfterStreamRef = useRef(null);
  const [srAnnouncement, setSrAnnouncement] = useState('');
  const srClearTimeoutRef = useRef(null);
  const srRafRef = useRef(null);
  const chatAreaRef = useRef(null);
  const notifyTitle = useTitleNotification(
    lesson ? `${lesson.name} — plato` : 'Lesson — plato'
  );

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState(null);
  const [showObjectives, setShowObjectives] = useState(false);
  const objectivesTitleRef = useRef(null);
  const keyboardOffset = useVisualViewportKeyboardOffset();
  const draftStorageKey = lessonGroupId ? `plato_compose_draft:${lessonGroupId}` : null;
  const [composeText, setComposeText] = useState(() => {
    if (!draftStorageKey) return '';
    try { return sessionStorage.getItem(draftStorageKey) || ''; } catch { return ''; }
  });
  const [composeImages, setComposeImages] = useState([]);
  const [composeLinks, setComposeLinks] = useState([]);

  // Sync draft text when switching between lessons and persist edits to sessionStorage
  // so mobile background tab discards do not wipe an in-progress reflection.
  useEffect(() => {
    if (!draftStorageKey) return;
    try { setComposeText(sessionStorage.getItem(draftStorageKey) || ''); } catch { setComposeText(''); }
  }, [draftStorageKey]);

  useEffect(() => {
    if (!draftStorageKey) return;
    try {
      if (composeText) sessionStorage.setItem(draftStorageKey, composeText);
      else sessionStorage.removeItem(draftStorageKey);
    } catch { /* ignore storage quota errors */ }
  }, [draftStorageKey, composeText]);

  useEffect(() => {
    if (displayText === null && pendingAfterStreamRef.current) {
      const { msgs, p, achieved } = pendingAfterStreamRef.current;
      pendingAfterStreamRef.current = null;
      if (msgs) {
        setMessages(msgs);
        const hasAssistant = msgs.some(m => m.role === 'assistant');
        if (hasAssistant) {
          if (srClearTimeoutRef.current) clearTimeout(srClearTimeoutRef.current);
          if (srRafRef.current) cancelAnimationFrame(srRafRef.current);
          setSrAnnouncement('');
          notifyTitle();
          // If focus is inside the chat log, move it to the new message so
          // VoiceOver announces it via the inline "Coach says:" prefix.
          // Otherwise fire the live region — both paths must not run together
          // or VoiceOver reads "Coach says: … New message from coach" as one
          // utterance, which sounds like the coach said those words.
          srRafRef.current = requestAnimationFrame(() => {
            srRafRef.current = null;
            const log = chatAreaRef.current;
            const focusInLog = log && (log.contains(document.activeElement) || document.activeElement === log);
            if (focusInLog) {
              const assistantMsgs = log.querySelectorAll('[data-chat-message="assistant"]');
              const last = assistantMsgs[assistantMsgs.length - 1];
              if (last) last.focus();
            } else {
              setSrAnnouncement('New message from coach');
              srClearTimeoutRef.current = setTimeout(() => setSrAnnouncement(''), 3000);
            }
          });
        }
      }
      if (p) setPhase(p);
      if (achieved) {
        setCelebratedLessonId(lessonGroupId);
        // Signal lesson list to refresh completion state
        window.dispatchEvent(new CustomEvent('plato:lesson-completed', {
          detail: { lessonId: lessonGroupId }
        }));
      }
      setLoading('');
    }
  }, [displayText]);

  useEffect(() => {
    if (!pendingSave && !loading) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pendingSave, loading]);

  useEffect(() => () => {
    if (srClearTimeoutRef.current) clearTimeout(srClearTimeoutRef.current);
    if (srRafRef.current) cancelAnimationFrame(srRafRef.current);
  }, []);

  // Move focus to the Objectives dialog title when it opens so screen
  // readers announce the dialog's purpose instead of landing on the close button.
  useEffect(() => {
    if (!showObjectives) return;
    const id = requestAnimationFrame(() => {
      objectivesTitleRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [showObjectives]);

  useEffect(() => {
    const lesson = lessonRef.current;
    if (!lesson) return;
    let cancelled = false;
    setCelebratedLessonId(null);
    setResuming(true);
    setMessages([]);
    setLessonKB(null);
    setPhase(null);
    setError('');
    setPersistence(null);
    setStartFailed(false);
    setLoading('');
    setStreamingText(null);
    pendingAfterStreamRef.current = null;

    (async () => {
      try {
        const existing = await engine.resumeLesson(lessonGroupId);
        if (cancelled) return;

        if (existing.messages.length > 0) {
          setMessages(existing.messages);
          setLessonKB(existing.lessonKB);
          setPhase(existing.phase);
          setPersistence(existing.persistence || null);
        } else if (impersonating) {
          // Admin "View as User": the target hasn't started this lesson yet.
          // Don't auto-start (engine guard would throw, and we'd be writing
          // with the admin's JWT anyway). Show an informational state instead.
          setError('This learner has not started this lesson yet — there is nothing to view.');
          setPhase(LESSON_PHASES.LEARNING);
        } else {
          setError('');
          setStartFailed(false);
          setLoading('starting');
          setLoadingStep('initializing');
          setLoadingEnrichments([]);
          setStreamingText('');
          try {
            const result = await engine.startLesson(
              lessonGroupId,
              lesson,
              (partial) => { if (!cancelled) setStreamingText(partial); },
              (step, data) => {
                if (!cancelled) {
                  setLoadingStep(step);
                  if (data?.enrichments) setLoadingEnrichments(data.enrichments);
                }
              }
            );
            if (cancelled) return;
            setLessonKB(result.lessonKB);
            setPersistence(result.persistence || null);
            pendingAfterStreamRef.current = { msgs: result.conversation || result.messages, p: result.phase };
            setStreamingText(null);
          } catch (e) {
            if (!cancelled) {
              setError(aiErrorMessage(e, 'coach-start'));
              setStartFailed(true);
              setLoading('');
              setStreamingText(null);
            }
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'The saved lesson could not be loaded. Try again.');
          setStartFailed(true);
        }
      } finally { if (!cancelled) setResuming(false); }
    })();

    return () => { cancelled = true; };
  }, [lessonGroupId, lessonLoaded, impersonating, startAttempt, viewKey]);

  const retryStart = () => {
    // The error and its button are replaced by the loading view, so park focus
    // on the lesson heading rather than letting it fall to <body>.
    headingRef.current?.focus();
    setStartAttempt((n) => n + 1);
  };

  const handleSend = useCallback(async ({ text, imageDataUrls, links }) => {
    const hasImages = Array.isArray(imageDataUrls) && imageDataUrls.length > 0;
    const hasLinks = Array.isArray(links) && links.length > 0;
    if (!text && !hasImages && !hasLinks) return;
    setError('');
    setLoading('qa');
    setStreamingText('');

    const optimisticMeta = (hasImages || hasLinks)
      ? {
          ...(hasImages ? { imageDataUrls } : {}),
          ...(hasLinks ? { links: links.map(({ url, title }) => ({ url, title })) } : {}),
        }
      : null;
    const optimisticMessage = {
      role: 'user', content: text || '', msgType: MSG_TYPES.USER,
      phase: LESSON_PHASES.LEARNING,
      metadata: optimisticMeta,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, optimisticMessage]);

    try {
      const result = await engine.sendMessage(
        lessonGroupId, lesson, text, imageDataUrls, links,
        (partial) => { if (activeView.current === viewKey) setStreamingText(partial); }
      );
      if (activeView.current !== viewKey) return;
      setPersistence(result.persistence || null);
      pendingAfterStreamRef.current = {
        msgs: result.conversation, p: result.phase,
        achieved: result.achieved && result.persistence?.status === 'saved',
      };
      setStreamingText(null);
      setLessonKB(result.lessonKB);
    } catch (e) {
      if (activeView.current !== viewKey) return;
      setError(aiErrorMessage(e, 'coach-reply'));
      setComposeText(text || '');
      setComposeImages((imageDataUrls || []).map((dataUrl, index) => ({ dataUrl, name: `Attached image ${index + 1}` })));
      setComposeLinks(links || []);
      setMessages(prev => prev.filter(message => message !== optimisticMessage));
      setStreamingText(null);
      setLoading('');
    }
  }, [lessonGroupId, lesson, viewKey]);

  const retrySave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setLoading('saving');
    setError('');
    try {
      const result = await engine.retryLessonSave(lessonGroupId);
      if (activeView.current !== viewKey) return;
      setPersistence(result.persistence);
      if (result.persistence.status === 'saved') {
        setMessages(result.conversation);
        setLessonKB(result.lessonKB);
        setPhase(result.lessonKB?.status === 'completed' ? LESSON_PHASES.COMPLETED : LESSON_PHASES.LEARNING);
        headingRef.current?.focus();
        if (result.achieved) {
          setCelebratedLessonId(lessonGroupId);
          window.dispatchEvent(new CustomEvent('plato:lesson-completed', { detail: { lessonId: lessonGroupId } }));
        }
      }
    } catch (e) {
      if (activeView.current === viewKey) setError(e.message);
    } finally {
      savingRef.current = false;
      if (activeView.current === viewKey) setLoading('');
    }
  };

  const loadSavedConversation = () => setConfirmModal({
    title: 'Load the saved conversation?',
    message: 'This discards the unsaved reply kept in this tab. Copy the reply first if you want to keep it.',
    confirmLabel: 'Discard unsaved reply',
    onConfirm: async () => {
      try {
        await engine.discardLessonReply(lessonGroupId);
        if (activeView.current === viewKey) setStartAttempt(n => n + 1);
      } catch (e) { if (activeView.current === viewKey) setError(e.message); }
    },
  });

  const isCustomLesson = lessonGroupId?.startsWith('custom-');

  // Find the next lesson in the same course
  const nextLesson = (() => {
    if (!lesson || !lessons.length) return null;
    if (!lesson.course?.id) return null; // No next lesson for uncategorized lessons

    // Get lessons in the same course, sorted by name
    const sameCourse = lessons
      .filter(l => l.course?.id === lesson.course?.id)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    // Find current lesson index in the sorted list
    const currentIndex = sameCourse.findIndex(l => l.lessonId === lessonGroupId);

    // Return next lesson in the course (if any)
    if (currentIndex >= 0 && currentIndex < sameCourse.length - 1) {
      return sameCourse[currentIndex + 1];
    }

    return null;
  })();

  const handleExport = useCallback(async () => {
    const markdown = await getUserLessonMarkdown(lessonGroupId);
    if (!markdown) return;
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${lesson?.name || 'lesson'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [lessonGroupId, lesson]);

  const handleReset = () => {
    setConfirmModal({
      title: 'Reset Lesson?',
      message: "This will delete all progress. You'll start from scratch.",
      confirmLabel: 'Reset Lesson',
      onConfirm: async () => { await deleteLessonProgress(lessonGroupId); navigate('/lessons'); },
    });
  };

  const handleDelete = () => {
    setConfirmModal({
      title: 'Delete Lesson?',
      message: 'This will permanently delete this lesson and all its progress.',
      confirmLabel: 'Delete Lesson',
      onConfirm: async () => {
        await deleteLessonProgress(lessonGroupId);
        await deleteUserLesson(lessonGroupId);
        dispatch({ type: 'REFRESH_LESSONS', lessons: lessons.filter(item => item.lessonId !== lessonGroupId) });
        navigate('/lessons');
        await reloadLessons();
      },
    });
  };

  if (!state.loaded) return <div className="flex items-center justify-center py-12 text-muted-foreground" role="status" aria-live="polite">Loading...</div>;
  if (!lesson) {
    return (
      <div className="mx-auto max-w-5xl space-y-2 p-4">
        <h1 className="text-xl font-semibold">Lesson not found</h1>
        <Link to="/lessons" className="text-sm text-link underline underline-offset-4">Back to lessons</Link>
      </div>
    );
  }
  const busy = !!loading || pendingSave || resuming;
  const composePlaceholder = phase === LESSON_PHASES.COMPLETED
    ? 'Share feedback about this lesson...'
    : 'Chat with your coach...';

  const renderMessage = (msg, idx) => {
    switch (msg.msgType) {
      case MSG_TYPES.GUIDE:
        return <AssistantMessage key={idx} content={msg.content} />;
      case MSG_TYPES.USER:
        return (
          <div key={idx}>
            {msg.content && <UserMessage content={msg.content} />}
            {(() => {
              const urls = Array.isArray(msg.metadata?.imageDataUrls)
                ? msg.metadata.imageDataUrls
                : msg.metadata?.imageDataUrl ? [msg.metadata.imageDataUrl] : [];
              if (urls.length === 0) return null;
              return (
                <div className="flex justify-end mt-1">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary p-1.5 flex flex-wrap gap-1">
                    {urls.map((url, i) => (
                      // Hydrated data URLs are already in memory: lazy loading
                      // saved nothing and decoded late, shifting the scrolled log.
                      <img key={i} src={url} alt={`Your uploaded work ${i + 1}`} decoding="async" className="max-w-full rounded-lg" />
                    ))}
                  </div>
                </div>
              );
            })()}
            {Array.isArray(msg.metadata?.links) && msg.metadata.links.length > 0 && (
              <div className="flex justify-end mt-1">
                <div className="flex max-w-[85%] flex-col items-end gap-1">
                  {msg.metadata.links.map((link, i) => {
                    let host = link.url;
                    try { host = new URL(link.url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
                    return (
                      <a
                        key={i}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Attached link: ${link.title || host} (${host}) — opens in a new tab`}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:underline"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                        </svg>
                        <span className="truncate" aria-hidden="true">{link.title || host}</span>
                        <span className="shrink-0 opacity-80" aria-hidden="true">{host}</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      default:
        return <AssistantMessage key={idx} content={msg.content} />;
    }
  };

  return (
    <div className="flex flex-col min-h-[calc(100dvh-theme(spacing.20))]">
      {/* One header stays visible and accessible throughout the conversation. */}
      <div id="lesson-header" className="sticky top-0 z-40 border-b border-border bg-background px-4 py-1.5 sm:py-2">
        <div className="mx-auto max-w-5xl flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label="Back to lessons" onClick={() => navigate('/lessons')}>
            <ArrowLeft aria-hidden="true" />
          </Button>
          <div className="flex-1 min-w-0">
            {/* The title stacks above Overview on narrow screens and wraps rather
                than truncating; three lines caps the sticky header's height. */}
            <div className="flex flex-col items-start gap-x-2 sm:flex-row sm:items-center sm:justify-between">
              <h1 ref={headingRef} tabIndex={-1} className="text-sm font-semibold break-words line-clamp-3 min-w-0">{lesson.name}</h1>
              <button
                type="button"
                className="touch-target rounded-sm text-left text-xs text-primary-text hover:underline cursor-pointer whitespace-nowrap shrink-0"
                onClick={() => setShowObjectives(true)}
                aria-expanded={showObjectives}
                aria-controls="lesson-objectives-dialog"
              >
                Overview ({lesson.learningObjectives.length})
              </button>
            </div>
            <ProgressBar lessonKB={lessonKB} celebrate={celebratedLessonId === lessonGroupId} />
          </div>
          {isCustomLesson && (
            <Button variant="ghost" size="icon-sm" onClick={handleExport} aria-label="Export lesson" title="Export lesson markdown">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </Button>
          )}
          {phase && (
            <Button variant="ghost" size="icon-sm" disabled={busy} onClick={handleReset} aria-label="Reset lesson" title="Reset lesson">
              <RotateCcw aria-hidden="true" />
            </Button>
          )}
          {isCustomLesson && (
            <Button variant="ghost" size="icon-sm" disabled={busy} onClick={handleDelete} aria-label="Delete lesson" title="Delete lesson">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1">
      {resuming && !loading ? (
        <p className="px-4 py-8 text-sm text-muted-foreground" role="status">Loading your saved conversation…</p>
      ) : loading === 'starting' && !displayText ? (
        <LessonLoadingView step={loadingStep} enrichments={loadingEnrichments} />
      ) : (
        <ChatArea ref={chatAreaRef} announcement={srAnnouncement}>
          {messages.map(renderMessage)}
          {displayText != null && displayText.length > 0 && (
            <AssistantMessage content={displayText} streaming />
          )}
          {loading === 'qa' && !displayText && <ThinkingSpinner />}
          {persistence && (
            <div className="space-y-2 px-3 py-2">
              <p className="text-sm" role="status" aria-live="polite">{persistence.message}</p>
              {pendingSave && !persistence.persistedLocally && (
                <p className="text-sm text-destructive">Keep this tab open until saving succeeds. A recovery copy could not be stored in your browser.</p>
              )}
              {pendingSave && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={retrySave} disabled={!!loading}>
                    {loading === 'saving' ? 'Saving…' : 'Retry saving'}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={!!loading} onClick={async () => {
                    try { await navigator.clipboard.writeText(messages.at(-1)?.content || ''); setSrAnnouncement('Reply copied'); }
                    catch { setError('Copy was unavailable. Select the reply text to copy it.'); }
                  }}>Copy reply</Button>
                  {persistence.status === 'conflict' && (
                    <Button variant="ghost" size="sm" onClick={loadSavedConversation} disabled={!!loading}>Load saved conversation</Button>
                  )}
                </div>
              )}
            </div>
          )}
          {error && (
            <div className="space-y-2 px-3 py-2">
              <p className="text-sm text-destructive" role="alert">{error}</p>
              {startFailed && (
                <Button variant="outline" size="sm" onClick={retryStart}>Try again</Button>
              )}
            </div>
          )}
          {phase === LESSON_PHASES.COMPLETED && !pendingSave && (
            <div className="flex flex-col items-center gap-3 mt-8 mb-4 px-4">
              {nextLesson ? (
                <Button
                  size="lg"
                  onClick={() => navigate(`/lessons/${nextLesson.lessonId}`)}
                  className="min-w-[200px]"
                  aria-label={`Continue to next lesson: ${nextLesson.name}`}
                >
                  Continue to Next Lesson
                </Button>
              ) : (
                <Button
                  size="lg"
                  onClick={() => navigate('/lessons')}
                  className="min-w-[200px]"
                  aria-label="Back to lesson list"
                >
                  Back to Lesson List
                </Button>
              )}
            </div>
          )}
        </ChatArea>
      )}
      </div>

      {/* Single sticky compose bar — stays mounted across scroll/resize so virtual
          keyboard focus and open attachment UI are never destroyed mid-typing. */}
      {phase && (
        <div
          className="compose-sticky-bar sticky bottom-0 z-30 bg-workspace/95 backdrop-blur-xs pb-[env(safe-area-inset-bottom)]"
          style={keyboardOffset > 0 ? { transform: `translateY(-${keyboardOffset}px)` } : undefined}
        >
          <ComposeBar
            placeholder={impersonating ? 'Read-only — viewing as another user' : composePlaceholder}
            onSend={handleSend}
            disabled={impersonating}
            busy={busy}
            allowImages
            allowLinks
            text={composeText}
            onTextChange={setComposeText}
            images={composeImages}
            onImagesChange={setComposeImages}
            links={composeLinks}
            onLinksChange={setComposeLinks}
          />
        </div>
      )}

      {/* Objectives dialog — bottom sheet on mobile, centered dialog on desktop */}
      <Dialog open={showObjectives} onOpenChange={setShowObjectives}>
        <DialogContent id="lesson-objectives-dialog" variant="sheet">
          <DialogHeader>
            <DialogTitle ref={objectivesTitleRef} tabIndex={-1}>{lesson.name}</DialogTitle>
            {lesson.description && <DialogDescription>{lesson.description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Exemplar</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{lesson.exemplar}</p>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Learning Objectives</h3>
            <ul className="list-disc pl-5 text-sm text-muted-foreground leading-relaxed space-y-1">
              {lesson.learningObjectives.map((obj, i) => (
                <li key={i}>{obj}</li>
              ))}
            </ul>
          </div>
          {lessonKB?.enrichments && lessonKB.enrichments.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Additional Context</h3>
              <p className="text-xs text-muted-foreground">
                Reference material gathered for this lesson from enabled plugins
              </p>
              {lessonKB.enrichments.map((enrichment, idx) => (
                <section
                  key={idx}
                  className="rounded-lg border border-border bg-muted/50 p-3 space-y-2"
                  aria-labelledby={`enrichment-${idx}-label`}
                >
                  <h4
                    id={`enrichment-${idx}-label`}
                    className="text-sm font-medium"
                  >
                    {enrichment.label || enrichment.pluginId}
                  </h4>
                  {enrichment.reasoning && (
                    <div role="note">
                      <p className="sr-only">Why this context matters:</p>
                      <p className="text-xs text-muted-foreground">
                        {enrichment.reasoning}
                      </p>
                    </div>
                  )}
                  {enrichment.context && (
                    <div>
                      <p className="sr-only">Context:</p>
                      <p className="text-sm whitespace-pre-wrap">
                        {enrichment.context}
                      </p>
                    </div>
                  )}
                  {enrichment.sources && enrichment.sources.length > 0 && (
                    <nav aria-label={`Sources from ${enrichment.label || enrichment.pluginId}`}>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Sources:</div>
                      <ul className="text-xs space-y-1">
                        {enrichment.sources.map((source, sidx) => (
                          <li key={sidx}>
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-sm text-link underline underline-offset-4 hover:decoration-2"
                              aria-label={`${source.title || source.url} (opens in new tab)`}
                            >
                              {source.title || source.url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </nav>
                  )}
                </section>
              ))}
            </div>
          )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowObjectives(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {confirmModal && (
        <ConfirmModal
          open={!!confirmModal}
          onOpenChange={(open) => { if (!open) setConfirmModal(null); }}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          onConfirm={() => { setConfirmModal(null); confirmModal.onConfirm(); }}
        />
      )}
    </div>
  );
}
