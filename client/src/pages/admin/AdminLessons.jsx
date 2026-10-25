import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { Info } from 'lucide-react';
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

import ConfirmModal from '../../components/modals/ConfirmModal.jsx';
import ShareLessonModal from '../../components/modals/ShareLessonModal.jsx';
import CoursesModal from './CoursesModal.jsx';
import LessonEditor from './LessonEditor.jsx';
import { MSG_TYPES } from '../../lib/constants.js';
import { canStartNewDraft, readLessonRecovery, lessonRecoveryKey } from '../../lib/lessonSaveQueue.js';

const PAGE_SIZE = 20;

function MetricHelp({ id, title, description }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        aria-label={`Information for ${title}`}
        aria-describedby={open ? id : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            e.stopPropagation();
          }
        }}
        className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Info className="size-3" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          role="tooltip"
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border bg-popover p-2 text-xs font-normal text-popover-foreground shadow-md normal-case leading-relaxed text-left whitespace-normal"
        >
          {description}
        </div>
      )}
    </div>
  );
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
  const [editorError, setEditorError] = useState('');
  const [editorAttempt, setEditorAttempt] = useState(0);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  // Only the first load swaps the list for a spinner. Refreshes (after a save,
  // delete, share, or a course change) keep the list and open dialogs mounted.
  const [lessonsLoaded, setLessonsLoaded] = useState(false);
  const [lessonsError, setLessonsError] = useState(null);
  const [coursesError, setCoursesError] = useState(null);
  const [lessonStats, setLessonStats] = useState({});
  const [statsError, setStatsError] = useState(null);
  const [lessonSearch, setLessonSearch] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
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
  const courseNamesById = useMemo(() => new Map(courses.map((c) => [c.courseId, c.name])), [courses]);
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

  const totalPages = Math.max(1, Math.ceil(filteredLessons.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageLessons = filteredLessons.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => {
    loadLessons();
    loadCourses();
    loadLessonStats();
  }, []);

  // The list and editor share this route component, so the list's title is
  // restored whenever the route returns to it (the editor sets its own).
  const onList = !routeLessonId && !isNewRoute;
  useEffect(() => {
    if (onList) document.title = 'Lessons — plato';
  }, [onList]);

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
    setLessonsLoaded(true);
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
  // minted draft id opens create mode. Other failures stay here for retry.
  useEffect(() => {
    if (!routeLessonId) { setEditing(null); return; }
    let cancelled = false;
    setEditorLoading(true);
    setEditorError('');
    let recovery;
    try { recovery = readLessonRecovery(sessionStorage, lessonRecoveryKey(user.userId, routeLessonId)); } catch { /* Storage can be unavailable. */ }
    (async () => {
      try {
        const data = await adminApi('GET', `/v1/admin/lessons/${encodeURIComponent(routeLessonId)}`);
        if (cancelled) return;
        // A record is a live draft iff status==='draft' and markdown is empty.
        // Legacy records with status='draft' but stored markdown are private.
        const isDraft = data.status === 'draft' && !data.markdown;
        const initialCourse = data.course || null;
        const markdown = data.markdown || '';
        const common = { version: data.version, operationId: data.authoringOperationId,
          conversationRevision: data.conversationRevision, markdownRevision: data.markdownRevision, recovery };
        if (data.conversation?.length) {
          // Resume the in-progress creation/edit conversation.
          setEditing({ ...common, lessonId: routeLessonId, conversation: data.conversation, readiness: data.readiness ?? (isDraft ? 1 : 8), isDraft, initialCourse, markdown });
        } else if (isDraft) {
          // Empty draft — open the editor in create mode.
          setEditing({ ...common, lessonId: routeLessonId, conversation: null, readiness: 0, isDraft: true, initialCourse, markdown: '' });
        } else {
          // Finalized lesson with no stored conversation — seed one with the
          // existing markdown so the agent has context to edit from.
          const seedConversation = [
            { role: 'user', content: `I want to edit an existing lesson. Here is the current lesson markdown:\n\n${data.markdown}\n\nWhat would you like to know about the changes I want to make?`, msgType: MSG_TYPES.USER },
          ];
          setEditing({ ...common, lessonId: routeLessonId, conversation: seedConversation, readiness: data.readiness ?? 8, needsAgentReply: true, isDraft: false, initialCourse, markdown });
        }
      } catch (failure) {
        if (cancelled) return;
        if (canStartNewDraft(routeLessonId, failure) || (failure.status === 404 && recovery?.version === 0)) {
          // Brand-new draft that hasn't auto-saved yet — open create mode.
          setEditing({ lessonId: routeLessonId, version: 0, recovery, conversation: null, readiness: 0, isDraft: true, initialCourse: null, markdown: '' });
        } else {
          setEditorError(failure.status === 404 ? 'This lesson was not found. It may have been deleted.' : 'This lesson could not be loaded. Retry to open your saved work.');
        }
      } finally {
        if (!cancelled) setEditorLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [routeLessonId, user.userId, editorAttempt]);

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
  // reload and browser-back. Finalizing saves the reviewed markdown and flips
  // status draft → private on the same record.
  if (routeLessonId) {
    if (editorError) return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Lesson unavailable</h1>
        <p role="alert">{editorError}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditorAttempt(value => value + 1)}>Retry loading lesson</Button>
          <Button variant="outline" onClick={() => navigate('/plato/lessons')}>Back to lessons</Button>
        </div>
      </div>
    );
    if (editorLoading || !editing || editing.lessonId !== routeLessonId) return spinner;
    return (
      <LessonEditor
        key={`${editing.lessonId}:${editorAttempt}`}
        userId={user.userId}
        version={editing.version}
        operationId={editing.operationId}
        conversationRevision={editing.conversationRevision}
        markdownRevision={editing.markdownRevision}
        recovery={editing.recovery}
        onReload={() => setEditorAttempt(value => value + 1)}
        lessonId={editing.lessonId}
        isDraft={editing.isDraft}
        initialMessages={editing.conversation}
        initialReadiness={editing.readiness}
        needsAgentReply={editing.needsAgentReply}
        initialCourse={editing.initialCourse}
        initialMarkdown={editing.markdown}
        onSave={async () => {
          setMessage({ text: editing.isDraft ? 'Lesson created (private).' : 'Lesson updated.', type: 'success' });
          navigate('/plato/lessons');
          void loadLessons();
        }}
        onCancel={() => { navigate('/plato/lessons'); void loadLessons(); }}
      />
    );
  }

  // Lesson list
  if (loading && !lessonsLoaded) return spinner;

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
          onChange={(e) => { setLessonSearch(e.target.value); setPage(1); }}
          className="w-full sm:max-w-xs"
        />
        <select
          id="lessons-course-filter"
          aria-label="Filter by course"
          value={courseFilter}
          onChange={(e) => { setCourseFilter(e.target.value); setPage(1); }}
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
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
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
              <TableHead className="text-right">
                <div className="inline-flex items-center justify-end gap-1">
                  <span>Completions</span>
                  <MetricHelp
                    id="help-completions"
                    title="Completions"
                    description="Completions of the published lesson."
                  />
                </div>
              </TableHead>
              <TableHead className="text-right">
                <div className="inline-flex items-center justify-end gap-1">
                  <span>Avg exchanges</span>
                  <MetricHelp
                    id="help-avg-exchanges"
                    title="Avg exchanges"
                    description={`Average exchanges on published completions. Over ${MAX_EXCHANGES} is past the lesson target.`}
                  />
                </div>
              </TableHead>
              <TableHead>Updated</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageLessons.map(c => {
              const isDraft = c.status === 'draft';
              const isPublic = c.status === 'public';
              const courseName = c.course ? (courseNamesById.get(c.course) || null) : null;
              const pacing = lessonStats[c.lessonId];
              const avgExchanges = pacing?.avgExchanges;
              const overPacing = typeof avgExchanges === 'number' && avgExchanges > MAX_EXCHANGES;
              return (
                <TableRow key={c.lessonId}>
                  <TableCell as="th" scope="row" className="whitespace-normal font-normal text-left">
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

      {/* Pagination */}
      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-3 mt-4" aria-label="Lessons pagination">
          <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page">
            Previous
          </Button>
          <span className="text-sm text-muted-foreground" aria-current="page">
            Page {currentPage} of {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setPage(p => p + 1)} aria-label="Next page">
            Next
          </Button>
        </nav>
      )}

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
