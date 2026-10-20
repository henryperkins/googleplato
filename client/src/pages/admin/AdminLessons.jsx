import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { adminApi } from './adminApi.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { MAX_EXCHANGES } from '../../lib/constants.js';
import { readinessFill } from '../../lib/readiness.js';

import ConfirmModal from '../../components/modals/ConfirmModal.jsx';
import ShareLessonModal from '../../components/modals/ShareLessonModal.jsx';
import CoursesModal from './CoursesModal.jsx';
import MarkdownPreviewPane from './MarkdownPreviewPane.jsx';
import { converseStream, extractLessonMarkdown } from '../../../js/orchestrator.js';
import { parseLessonPrompt } from '../../../js/lessonOwner.js';
import { parseResponse, cleanStream, buildConversationText } from '../../lib/lessonCreationEngine.js';
import { useStreamedText } from '../../hooks/useStreamedText.js';
import { useTitleNotification } from '../../hooks/useTitleNotification.js';
import { MSG_TYPES } from '../../lib/constants.js';
import { aiErrorMessage } from '../../lib/aiErrors.js';

import ChatArea from '../../components/chat/ChatArea.jsx';
import ComposeBar from '../../components/chat/ComposeBar.jsx';
import AssistantMessage from '../../components/chat/AssistantMessage.jsx';
import UserMessage from '../../components/chat/UserMessage.jsx';
import ThinkingSpinner from '../../components/chat/ThinkingSpinner.jsx';

// A draft id minted by /plato/lessons/new looks like `admin-<13-digit ms>`.
// Within a few minutes of minting, a 404 means "not auto-saved yet" rather
// than "bad id" — so the editor opens in create mode instead of bouncing to
// the list.
const FRESH_DRAFT_WINDOW_MS = 5 * 60 * 1000;
function isFreshlyMintedDraftId(id) {
  const m = /^admin-(\d{13})$/.exec(id || '');
  return !!m && Date.now() - Number(m[1]) < FRESH_DRAFT_WINDOW_MS;
}

export default function AdminLessons() {
  const navigate = useNavigate();
  const location = useLocation();
  const { lessonId: routeLessonId } = useParams();
  const { user } = useAuth();
  const isNewRoute = location.pathname.endsWith('/lessons/new');

  const [lessons, setLessons] = useState([]);
  const [courses, setCourses] = useState([]);
  const [coursesOpen, setCoursesOpen] = useState(false);
  // Editor data for the lesson open at /plato/lessons/:lessonId/edit.
  const [editing, setEditing] = useState(null); // { lessonId, conversation, readiness, needsAgentReply, isDraft, initialCourse, markdown }
  const [editorLoading, setEditorLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lessonsError, setLessonsError] = useState(null);
  const [coursesError, setCoursesError] = useState(null);
  const [lessonStats, setLessonStats] = useState({});
  const [statsError, setStatsError] = useState(null);
  const [lessonSearch, setLessonSearch] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [confirmModal, setConfirmModal] = useState(null);

  // /plato/lessons/new mints a fresh draft id and redirects to its stable
  // edit URL, so the editor survives reload and browser-back (it previously
  // had no route — a reload dropped the admin back to the list). The draft
  // record is created lazily by the editor's first auto-save.
  const newDraftIdRef = useRef(null);
  if (isNewRoute) {
    if (!newDraftIdRef.current) newDraftIdRef.current = `admin-${Date.now()}`;
  } else {
    newDraftIdRef.current = null;
  }
  useEffect(() => {
    if (isNewRoute && newDraftIdRef.current) {
      navigate(`/plato/lessons/${encodeURIComponent(newDraftIdRef.current)}/edit`, { replace: true });
    }
  }, [isNewRoute, navigate]);

  // Map courseId -> name for rendering tags on lesson rows.
  const courseNamesById = new Map(courses.map((c) => [c.courseId, c.name]));
  const filteredLessons = useMemo(() => {
    const q = lessonSearch.trim().toLowerCase();
    return lessons.filter((lesson) => {
      if (q && !(lesson.name || '').toLowerCase().includes(q) && !(lesson.lessonId || '').toLowerCase().includes(q)) return false;
      if (courseFilter === 'none' && lesson.course) return false;
      if (courseFilter && courseFilter !== 'none' && lesson.course !== courseFilter) return false;
      if (statusFilter !== 'all' && (lesson.status || 'private') !== statusFilter) return false;
      return true;
    });
  }, [lessons, lessonSearch, courseFilter, statusFilter]);

  useEffect(() => {
    document.title = 'Lessons — plato';
    loadLessons();
    loadCourses();
    loadLessonStats();
  }, []);

  async function loadCourses() {
    try {
      const data = await adminApi('GET', '/v1/admin/courses');
      setCourses(Array.isArray(data) ? data : []);
      setCoursesError(null);
    } catch (e) {
      setCoursesError(e?.message || 'Courses could not be loaded.');
    }
  }

  async function loadLessons() {
    setLoading(true);
    try {
      const data = await adminApi('GET', '/v1/admin/lessons');
      setLessons(Array.isArray(data) ? data : []);
      setLessonsError(null);
    } catch (e) {
      setLessonsError(e?.message || 'Lessons could not be loaded.');
    }
    setLoading(false);
  }

  async function loadLessonStats() {
    try {
      const data = await adminApi('GET', '/v1/admin/stats/lessons');
      setLessonStats(data?.byLesson || {});
      setStatsError(null);
    } catch (e) {
      setStatsError(e?.message || 'Lesson pacing stats could not be loaded.');
    }
  }

  // Open the editor for a lesson by navigating to its deep-linkable route.
  function openLessonEditor(lessonId) {
    navigate(`/plato/lessons/${encodeURIComponent(lessonId)}/edit`);
  }

  // Load the lesson for the :lessonId edit route. A just-minted draft has no
  // server record until the editor's first auto-save, so a 404 on a freshly
  // minted draft id opens create mode; any other failure bounces to the list
  // (mirrors the users/:userId deep-link pattern).
  useEffect(() => {
    if (!routeLessonId) { setEditing(null); return; }
    let cancelled = false;
    setEditorLoading(true);
    (async () => {
      try {
        const data = await adminApi('GET', `/v1/admin/lessons/${encodeURIComponent(routeLessonId)}`);
        if (cancelled) return;
        // A record is a live draft iff status==='draft' and markdown is empty.
        // Legacy records with status='draft' but stored markdown are private.
        const isDraft = data.status === 'draft' && !data.markdown;
        const initialCourse = data.course || null;
        const markdown = data.markdown || '';
        if (data.conversation?.length) {
          // Resume the in-progress creation/edit conversation.
          setEditing({ lessonId: routeLessonId, conversation: data.conversation, readiness: data.readiness ?? (isDraft ? 1 : 8), isDraft, initialCourse, markdown });
        } else if (isDraft) {
          // Empty draft — open the editor in create mode.
          setEditing({ lessonId: routeLessonId, conversation: null, readiness: 0, isDraft: true, initialCourse, markdown: '' });
        } else {
          // Finalized lesson with no stored conversation — seed one with the
          // existing markdown so the agent has context to edit from.
          const seedConversation = [
            { role: 'user', content: `I want to edit an existing lesson. Here is the current lesson markdown:\n\n${data.markdown}\n\nWhat would you like to know about the changes I want to make?`, msgType: MSG_TYPES.USER },
          ];
          setEditing({ lessonId: routeLessonId, conversation: seedConversation, readiness: data.readiness ?? 8, needsAgentReply: true, isDraft: false, initialCourse, markdown });
        }
      } catch {
        if (cancelled) return;
        if (isFreshlyMintedDraftId(routeLessonId)) {
          // Brand-new draft that hasn't auto-saved yet — open create mode.
          setEditing({ lessonId: routeLessonId, conversation: null, readiness: 0, isDraft: true, initialCourse: null, markdown: '' });
        } else {
          setMessage({ text: 'That lesson could not be opened.', type: 'error' });
          navigate('/plato/lessons', { replace: true });
        }
      } finally {
        if (!cancelled) setEditorLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [routeLessonId, navigate]);

  const [shareModal, setShareModal] = useState(null); // { lessonId, lessonName, sharedWith, status }

  function openShareModal(lessonId, lessonName, currentSharedWith, status) {
    setShareModal({ lessonId, lessonName, sharedWith: currentSharedWith || [], status: status || 'private' });
  }

  async function handleShareConfirm({ status, sharedWith }) {
    if (!shareModal) return;
    try {
      await adminApi('PUT', `/v1/admin/lessons/${encodeURIComponent(shareModal.lessonId)}`, { status, sharedWith });
      const msg = status === 'public'
        ? 'Lesson is now public.'
        : `Lesson shared with ${sharedWith.length} ${sharedWith.length === 1 ? 'user' : 'users'}.`;
      setMessage({ text: msg, type: 'success' });
      setShareModal(null);
      loadLessons();
    } catch (e) { setMessage({ text: e.message, type: 'error' }); }
  }

  function deleteLesson(lessonId) {
    setConfirmModal({
      title: 'Delete Lesson?',
      message: 'This will permanently delete this lesson. This cannot be undone.',
      confirmLabel: 'Delete Lesson',
      onConfirm: async () => {
        try {
          await adminApi('DELETE', `/v1/admin/lessons/${encodeURIComponent(lessonId)}`);
          setMessage({ text: 'Lesson deleted.', type: 'success' });
          loadLessons();
        } catch (e) { setMessage({ text: e.message, type: 'error' }); }
      },
    });
  }

  const spinner = (
    <div className="flex items-center justify-center py-12 text-muted-foreground" role="status" aria-live="polite">Loading...</div>
  );

  // Redirecting /plato/lessons/new → the freshly minted draft's edit URL.
  if (isNewRoute) return spinner;

  // Lesson editor — create a draft, resume a draft, or edit a finalized
  // lesson. Deep-linked at /plato/lessons/:lessonId/edit so it survives
  // reload and browser-back. When the record is a draft, finalizing extracts
  // markdown and flips status draft → private on the same record.
  if (routeLessonId) {
    if (editorLoading || !editing) return spinner;
    return (
      <NewLessonView
        key={editing.lessonId}
        lessonId={editing.lessonId}
        isDraft={editing.isDraft}
        initialMessages={editing.conversation}
        initialReadiness={editing.readiness}
        needsAgentReply={editing.needsAgentReply}
        initialCourse={editing.initialCourse}
        initialMarkdown={editing.markdown}
        onSave={async (name, markdown, conversation, readiness) => {
          // null name + markdown = the editor decided there was nothing new
          // to extract (e.g. admin only changed the course dropdown). Skip
          // the lesson PUT — those metadata changes auto-saved on edit —
          // but still show the toast and refresh the list so the admin
          // gets visible confirmation.
          if (name && markdown) {
            const body = { markdown, name, conversation, readiness };
            if (editing.isDraft) {
              body.status = 'private';
              body.sharedWith = [user.userId];
            }
            await adminApi('PUT', `/v1/admin/lessons/${encodeURIComponent(editing.lessonId)}`, body);
          }
          setMessage({ text: editing.isDraft ? 'Lesson created (private).' : 'Lesson updated.', type: 'success' });
          await loadLessons();
          navigate('/plato/lessons');
        }}
        onCancel={async () => { await loadLessons(); navigate('/plato/lessons'); }}
        onError={(text) => setMessage({ text, type: 'error' })}
      />
    );
  }

  // Lesson list
  if (loading) return spinner;

  return (
    <div>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between mb-4">
        <h1 className="text-2xl font-bold">Lessons</h1>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => navigate('/plato/lessons/new')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Lesson
          </Button>
          <Button variant="outline" onClick={() => setCoursesOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            Courses
          </Button>
        </div>
      </div>

      {/* Always-mounted live region — guarantees screen readers announce the
          success/error message even when the editor unmounts in the same
          render as the message is set (a conditionally-rendered role="alert"
          is sometimes missed because it's present on the list's first render
          rather than appearing dynamically). The visible alert below stays
          for sighted users; this sr-only region drives the announcement. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message?.text || ''}
      </div>

      {message && (
        <div
          className={`flex items-center justify-between rounded-lg border px-4 py-3 mb-4 text-sm ${
            message.type === 'error'
              ? 'border-danger-border bg-danger text-danger-foreground'
              : 'border-success-border bg-success text-success-foreground'
          }`}
          role="alert"
        >
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-lg leading-none hover:opacity-70">&times;</button>
        </div>
      )}

      {lessonsError && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-4 py-3 mb-4 text-sm text-danger-foreground" role="alert">
          <span>{lessonsError}</span>
          <Button variant="outline" size="sm" onClick={loadLessons}>Retry</Button>
        </div>
      )}
      {coursesError && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-4 py-3 mb-4 text-sm text-danger-foreground" role="alert">
          <span>{coursesError}</span>
          <Button variant="outline" size="sm" onClick={loadCourses}>Retry</Button>
        </div>
      )}
      {statsError && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning px-4 py-3 mb-4 text-sm text-warning-foreground" role="alert">
          <span>{statsError} Completions and average exchanges are hidden until stats load.</span>
          <Button variant="outline" size="sm" onClick={loadLessonStats}>Retry</Button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 mb-4">
        <Label htmlFor="lessons-search" className="sr-only">Search lessons</Label>
        <Input
          id="lessons-search"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Search lessons"
          value={lessonSearch}
          onChange={(e) => setLessonSearch(e.target.value)}
          className="w-full sm:max-w-xs"
        />
        <select
          id="lessons-course-filter"
          aria-label="Filter by course"
          value={courseFilter}
          onChange={(e) => setCourseFilter(e.target.value)}
          className="h-10 min-w-0 rounded-lg border border-input bg-transparent px-3 text-base md:text-sm"
        >
          <option value="">All courses</option>
          <option value="none">No course</option>
          {courses.map((course) => (
            <option key={course.courseId} value={course.courseId}>{course.name}</option>
          ))}
        </select>
        <select
          id="lessons-status-filter"
          aria-label="Filter by visibility"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-10 min-w-0 rounded-lg border border-input bg-transparent px-3 text-base md:text-sm"
        >
          <option value="all">All statuses</option>
          <option value="public">Public</option>
          <option value="private">Private</option>
          <option value="draft">Draft</option>
        </select>
      </div>

      <Card className="p-0 overflow-hidden">
        <Table aria-label="Lessons">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Course</TableHead>
              <TableHead className="text-right" title="Completions of the published lesson">Completions</TableHead>
              <TableHead className="text-right" title={`Average exchanges on published completions. Over ${MAX_EXCHANGES} is past the lesson target.`}>Avg exchanges</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredLessons.map(c => {
              const isDraft = c.status === 'draft';
              const isPublic = c.status === 'public';
              const courseName = c.course ? (courseNamesById.get(c.course) || null) : null;
              const pacing = lessonStats[c.lessonId];
              const avgExchanges = pacing?.avgExchanges;
              const overPacing = typeof avgExchanges === 'number' && avgExchanges > MAX_EXCHANGES;
              return (
                <TableRow key={c.lessonId}>
                  <TableCell className="whitespace-normal">
                    <div className="flex min-w-0 flex-col items-start gap-1">
                      <button
                        type="button"
                        onClick={() => openLessonEditor(c.lessonId)}
                        aria-label={isDraft ? `Resume draft ${c.name || c.lessonId}` : `Edit ${c.name || c.lessonId}`}
                        className="touch-target truncate max-w-full rounded-sm text-left font-medium underline underline-offset-4 cursor-pointer hover:text-link"
                      >
                        {c.name || c.lessonId}
                      </button>
                      {isDraft
                        ? <Badge variant="outline" className="shrink-0 text-xs border-warning-border bg-warning text-warning-foreground">Draft</Badge>
                        : isPublic
                          ? <Badge variant="outline" className="shrink-0 text-xs">Public</Badge>
                          : <Badge variant="outline" className="shrink-0 text-xs border-primary/30 bg-primary/10 text-primary-text">Private{c.sharedWith?.length ? ` (${c.sharedWith.length})` : ''}</Badge>
                      }
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{courseName || '\u2014'}</TableCell>
                  <TableCell className="text-right tabular-nums">{pacing ? pacing.completions : '\u2014'}</TableCell>
                  <TableCell className={`text-right tabular-nums ${overPacing ? 'font-medium text-warning-foreground' : ''}`}>
                    {typeof avgExchanges === 'number' ? avgExchanges : '\u2014'}
                    {overPacing && <span className="sr-only">, over the {MAX_EXCHANGES}-exchange target</span>}
                  </TableCell>
                  <TableCell>{c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : '\u2014'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1" role="group" aria-label={`Actions for ${c.name}`}>
                      {!isDraft && (
                        <Button variant="ghost" size="icon-xs" title="Visibility &amp; sharing" onClick={() => openShareModal(c.lessonId, c.name, c.sharedWith, c.status)} aria-label={`Visibility and sharing for ${c.name}`}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
                        </Button>
                      )}
                      <Button variant="ghost" size="icon-xs" title={isDraft ? 'Resume draft' : 'Edit'} onClick={() => openLessonEditor(c.lessonId)} aria-label={isDraft ? `Resume draft ${c.name}` : `Edit ${c.name}`}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                      </Button>
                      <Button variant="ghost" size="icon-xs" title="Delete" onClick={() => deleteLesson(c.lessonId)} aria-label={`Delete ${c.name}`}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {filteredLessons.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                  {lessonsError
                    ? 'Lessons could not be loaded. Retry above.'
                    : lessons.length === 0
                      ? 'No lessons yet. Click “Add Lesson” to create your first lesson.'
                      : 'No lessons match these filters.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {confirmModal && (
        <ConfirmModal
          open={!!confirmModal}
          onOpenChange={(open) => { if (!open) setConfirmModal(null); }}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          variant={confirmModal.variant}
          onConfirm={() => { setConfirmModal(null); confirmModal.onConfirm(); }}
        />
      )}

      <CoursesModal
        open={coursesOpen}
        onOpenChange={setCoursesOpen}
        onMutated={() => { loadCourses(); loadLessons(); }}
      />

      {shareModal && (
        <ShareLessonModal
          open={!!shareModal}
          onOpenChange={(open) => { if (!open) setShareModal(null); }}
          lessonName={shareModal.lessonName}
          initialSharedWith={shareModal.sharedWith}
          initialStatus={shareModal.status}
          onConfirm={handleShareConfirm}
        />
      )}
    </div>
  );
}

// -- Lesson creation/editing view with AI Chat --------------------------------

function NewLessonView({ onSave, onCancel, onError: _onError, lessonId, isDraft, initialMessages, initialReadiness, needsAgentReply, initialCourse, initialMarkdown }) {
  // A view is in "create" mode when it's driving a fresh or in-progress draft.
  // It's in "edit" mode when finalizing a non-draft lesson's content.
  const isCreate = !!isDraft;
  const pageTitle = isCreate ? 'New Lesson — plato' : 'Edit Lesson — plato';
  useEffect(() => { document.title = pageTitle; }, [pageTitle]);
  const notifyTitle = useTitleNotification(pageTitle);
  const [chatMessages, setChatMessages] = useState(initialMessages || []);
  const [readiness, setReadiness] = useState(initialReadiness ?? 0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [key, setKey] = useState(0); // increment to restart conversation
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [draftWarning, setDraftWarning] = useState('');
  const [courses, setCourses] = useState([]);
  const [course, setCourse] = useState(initialCourse || '');

  // Markdown preview pane. Refreshed manually via the lesson-extractor agent;
  // never persisted until the admin clicks Create/Update Lesson.
  const [previewMarkdown, setPreviewMarkdown] = useState(initialMarkdown || '');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  // Number of chat messages the current preview reflects. In edit mode the
  // saved markdown was extracted from the resumed conversation, so it starts
  // in sync; a fresh draft has no markdown yet.
  const [previewSyncedAt, setPreviewSyncedAt] = useState(
    initialMarkdown ? (initialMessages?.length || 0) : 0
  );

  // Load course list once on mount so the dropdown can populate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await adminApi('GET', '/v1/admin/courses');
        if (!cancelled && Array.isArray(data)) setCourses(data);
      } catch (e) {
        setError(e?.message || 'Courses could not be loaded. You can still create the lesson.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Streaming
  const [streamingText, setStreamingText] = useState(null);
  const displayText = useStreamedText(streamingText);
  const pendingRef = useRef(null);
  const [srAnnouncement, setSrAnnouncement] = useState('');

  // Auto-save conversation after each exchange. Drafts use the main PUT with
  // status=draft so the first save creates the record; non-drafts use the
  // lighter /conversation endpoint that never touches markdown or status.
  // Drafts also fold the current course assignment into the same payload so
  // a course chosen before the first save is persisted along with the record.
  const readinessRef = useRef(readiness);
  useEffect(() => { readinessRef.current = readiness; }, [readiness]);
  const courseRef = useRef(course);
  useEffect(() => { courseRef.current = course; }, [course]);
  useEffect(() => {
    if (chatMessages.length === 0) return;
    const conversation = chatMessages.map(m => ({ role: m.role, content: m.content, msgType: m.msgType }));
    const r = readinessRef.current;
    if (isCreate) {
      adminApi('PUT', `/v1/admin/lessons/${encodeURIComponent(lessonId)}`, {
        status: 'draft',
        name: 'Untitled draft',
        conversation,
        readiness: r,
        course: courseRef.current || null,
      }).then(() => setDraftWarning('')).catch(() => setDraftWarning('Draft could not be saved. Your latest message is still on this page.'));
    } else {
      adminApi('PUT', `/v1/admin/lessons/${encodeURIComponent(lessonId)}/conversation`, { conversation, readiness: r })
        .then(() => setDraftWarning(''))
        .catch(() => setDraftWarning('Draft could not be saved. Your latest message is still on this page.'));
    }
  }, [chatMessages, isCreate, lessonId]);

  // Persist the course immediately on change. Works for finalized lessons too
  // (the lesson PUT preserves all other fields when only `course` is sent).
  // For brand-new drafts that don't yet have a server record, the auto-save
  // effect above will pick up courseRef on its first tick.
  async function changeCourse(nextCourseId) {
    setCourse(nextCourseId);
    try {
      const body = { course: nextCourseId || null };
      // Drafts must keep status=draft and name on PUTs; preserve them.
      if (isCreate) {
        body.status = 'draft';
        body.name = 'Untitled draft';
      }
      await adminApi('PUT', `/v1/admin/lessons/${encodeURIComponent(lessonId)}`, body);
    } catch (e) {
      setError(e.message || 'Failed to update course.');
    }
  }

  // Handle stream drain completing
  useEffect(() => {
    if (displayText === null && pendingRef.current) {
      const { msgs, r } = pendingRef.current;
      pendingRef.current = null;
      if (msgs) {
        setChatMessages(prev => [...prev, ...msgs]);
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

  // Start conversation on mount (and on key change after lesson creation).
  // Skip when resuming an existing conversation that already has an agent reply.
  const skipInitRef = useRef(!!initialMessages?.length && !needsAgentReply);
  useEffect(() => {
    if (skipInitRef.current) {
      skipInitRef.current = false;
      return;
    }
    if (chatMessages.length > 0 && key === 0) return;
    let cancelled = false;

    // Determine the opening message(s) to send to the agent
    const openingMessages = (needsAgentReply && initialMessages?.length)
      ? initialMessages.map(m => ({ role: m.role, content: m.content }))
      : [{ role: 'user', content: 'I want to create a new lesson.' }];

    if (!needsAgentReply) {
      setChatMessages([]);
      setReadiness(0);
    }
    setBusy('starting');
    setStreamingText('');
    setError('');

    (async () => {
      try {
        const raw = await converseStream(
          'lesson-creator',
          openingMessages,
          cleanStream((partial) => { if (!cancelled) setStreamingText(partial); }),
          512
        );
        if (cancelled) return;
        const { text, readiness: r } = parseResponse(raw);
        const msg = { role: 'assistant', content: text, msgType: MSG_TYPES.GUIDE, timestamp: Date.now() };
        pendingRef.current = { msgs: [msg], r: r ?? readiness };
        setStreamingText(null);
      } catch (e) {
        if (!cancelled) { setError(aiErrorMessage(e, 'lesson-creator')); setBusy(''); setStreamingText(null); }
      }
    })();

    return () => { cancelled = true; };
  }, [key]);

  // Keep a ref to chatMessages so handleSend always has the latest
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
        'lesson-creator',
        tail,
        cleanStream((partial) => setStreamingText(partial)),
        512
      );

      const { text: respText, readiness: r } = parseResponse(raw);
      const assistantMsg = { role: 'assistant', content: respText, msgType: MSG_TYPES.GUIDE, timestamp: Date.now() };
      pendingRef.current = { msgs: [assistantMsg], r };
      setStreamingText(null);
    } catch (e) {
      setError(aiErrorMessage(e, 'lesson-creator'));
      setStreamingText(null);
      setBusy('');
    }
  }, []);

  async function handleCreate() {
    setError('');
    // When editing an existing finalized lesson, an admin may open the editor
    // just to change a metadata field (e.g. the course assignment) without
    // chatting with the agent. Those changes auto-save on edit, so there's
    // nothing for the lesson-extractor to do and the conversation hasn't
    // grown beyond the seed prompt + the agent's first reply. Skip the
    // re-extraction (which would fail with "Could not build a complete
    // lesson") and call onSave with null markdown — the parent skips the
    // lesson PUT but still shows the success toast and refreshes the list,
    // so the admin gets visible confirmation that their metadata change
    // landed.
    const userMsgCount = chatMessages.filter(m => m.role === 'user').length;
    if (!isCreate && userMsgCount <= 1) {
      setBusy('creating');
      try {
        await onSave(null, null, null, null);
      } catch (e) {
        setError(e.message || 'Failed to update lesson.');
        setBusy('');
      }
      return;
    }
    setBusy('creating');
    try {
      const md = await extractLessonMarkdown(buildConversationText(chatMessages));
      const lesson = parseLessonPrompt(lessonId, md);

      if (!lesson.name || !lesson.exemplar || !lesson.learningObjectives.length) {
        setError('Could not build a complete lesson. Keep refining with the agent.');
        setBusy('');
        return;
      }

      // Keep the preview in sync with what we're about to save.
      setPreviewMarkdown(md);
      setPreviewSyncedAt(chatMessages.length);

      // Save conversation alongside the markdown so it can be resumed later
      const conversation = chatMessages.map(m => ({ role: m.role, content: m.content, msgType: m.msgType }));
      await onSave(lesson.name, md, conversation, readiness);
    } catch (e) {
      setError(aiErrorMessage(e, 'lesson-builder'));
      setBusy('');
    }
  }

  const isBusy = !!busy;
  const previewStale = !!previewMarkdown && chatMessages.length > previewSyncedAt;

  // Refresh the markdown preview by re-running the lesson-extractor agent.
  // Runs independently of the chat — never sets `busy`.
  async function handleRefreshPreview() {
    if (chatMessages.length === 0) {
      setPreviewError('Start the conversation first, then refresh.');
      return;
    }
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const md = await extractLessonMarkdown(buildConversationText(chatMessages));
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
      <div className="flex items-center gap-3 mb-4">
        <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Back to lessons">&larr; Back</Button>
        <h1 className="text-2xl font-bold">{isCreate ? 'New Lesson' : 'Edit Lesson'}</h1>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-lg border border-danger-border bg-danger text-danger-foreground px-4 py-3 mb-4 text-sm" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss error" className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-lg leading-none hover:opacity-70">&times;</button>
        </div>
      )}
      {draftWarning && (
        <p className="text-sm text-warning-foreground mb-4" role="status">{draftWarning}</p>
      )}

      {/* Lesson metadata — course assignment.
          Visible during creation and editing; admins can re-assign at any time. */}
      <div className="flex items-center gap-3 min-w-0 mb-4">
        <label htmlFor="lesson-course" className="text-sm text-muted-foreground shrink-0">Course</label>
        <select
          id="lesson-course"
          value={course}
          onChange={(e) => changeCourse(e.target.value)}
          className="flex h-9 min-w-0 max-w-full flex-1 sm:flex-initial truncate rounded-md border border-input bg-transparent px-3 py-1 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">No course</option>
          {courses.map((c) => (
            <option key={c.courseId} value={c.courseId}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Readiness bar + Create Lesson button */}
      {(chatMessages.length > 0 || displayText != null) && (
        <div className="admin-sticky-bar sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur-xs flex flex-wrap items-end gap-3 mb-4">
          <div
            className="flex-1 min-w-0"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={10}
            aria-valuenow={readiness}
            aria-label={`Lesson readiness: ${readiness} out of 10`}
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
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              onClick={() => setConfirmRestart(true)}
              disabled={isBusy}
              size="sm"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              Start over
            </Button>
            <Button
              onClick={handleCreate}
              disabled={isBusy || (isCreate && readiness < 3)}
              size="sm"
              aria-describedby={isCreate && readiness < 3 ? 'create-lesson-hint' : undefined}
            >
              {busy === 'creating' ? (isCreate ? 'Creating...' : 'Updating...') : (isCreate ? 'Create Lesson' : 'Update Lesson')}
            </Button>
          </div>
          {isCreate && readiness < 3 && (
            <p id="create-lesson-hint" className="basis-full text-xs text-muted-foreground">
              Keep chatting until readiness is at least 3 of 10 before creating the lesson.
            </p>
          )}
        </div>
      )}
      <ConfirmModal
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="Start over?"
        message="This clears the conversation and resets the readiness score. It cannot be undone."
        confirmLabel="Start over"
        variant="destructive"
        onConfirm={() => setKey(k => k + 1)}
      />

      {/* Chat (left) + markdown preview (right). Stacks vertically below `lg`. */}
      <div className="flex flex-col lg:flex-row gap-4">
        <div className="lg:w-3/5 min-w-0">
          {/* Chat + compose in a single container */}
          <div className="rounded-2xl bg-muted/40 p-2 sm:p-4">
            <div className="mb-3">
              <ChatArea announcement={srAnnouncement}>
                {chatMessages.map(renderMessage)}
                {displayText != null && displayText.length > 0 && (
                  <AssistantMessage content={displayText} streaming />
                )}
                {busy === 'starting' && !displayText && <ThinkingSpinner text="Starting..." />}
                {busy === 'creating' && <ThinkingSpinner text="Generating lesson..." />}
                {busy === 'qa' && !displayText && <ThinkingSpinner />}
              </ChatArea>
            </div>

            <ComposeBar
              placeholder="Describe what you want to teach..."
              storageKey={`plato_lesson_editor_draft:${lessonId || 'new'}`}
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
            stale={previewStale}
            saveLabel={isCreate ? 'Create Lesson' : 'Update Lesson'}
            refreshDisabled={previewLoading || isBusy}
            onRefresh={handleRefreshPreview}
          />
        </div>
      </div>
    </div>
  );
}
