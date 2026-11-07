import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useBlocker } from 'react-router-dom';
import { ChevronDown, X } from 'lucide-react';
import { adminApi } from './adminApi.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { can } from '../../lib/permissions.js';
import { requestError } from '../../lib/authErrors.js';
import useMediaQuery from '../../hooks/useMediaQuery.js';
import ConfirmModal from '../../components/modals/ConfirmModal.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

/**
 * Admin → Notifications (#388, #389, #400): one place for everything plato
 * sends. Compose (a one-off message, in the classroom and/or by email),
 * Automations (on/off plus the email copy), History. Server:
 * routes/admin-notifications.js, lib/notifications.js, lib/messages.js.
 *
 * Unsent and unsaved work lives above the tabs, so switching tabs never
 * discards it, and leaving the page asks first. Each action reports beside
 * itself and keeps focus while it works.
 */

// In the order the Automations tab lists them.
const AVAILABLE = ['waitlistConfirmation', 'waitlistRemoved', 'inactivityNudge', 'weeklyDigest'];
const AUTOMATION_TEMPLATE = {
  waitlistConfirmation: 'waitlist-confirmation', waitlistRemoved: 'waitlist-removed',
  inactivityNudge: 'inactivity-nudge', weeklyDigest: 'weekly-digest',
};
// Invitation emails: always sent, no switch, editable (server: ALWAYS_ON).
const ALWAYS_ON = ['invite', 'account-invite'];
// A message's "By role" choices, in the order shown.
const ROLE_OPTIONS = [['learner', 'Learners'], ['educator', 'Educators'], ['admin', 'Admins'], ['tester', 'Testers']];
const MESSAGE_VARIABLES = ['firstName', 'classroomName'];
// Below 48rem History is a list, as the Users directory is.
const NARROW = '(max-width: 47.999rem)';

const vars = (list) => list.map((v) => `{{${v}}}`).join(', ');
const peopleCount = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
const toneOf = (status) => (status?.type === 'error' ? 'text-destructive'
  : status?.type === 'success' ? 'text-success-foreground' : 'text-muted-foreground');
// The server's reason, or a plain one when the network or the response failed.
const problem = (error, fallback) => (error instanceof SyntaxError ? fallback : requestError(error, fallback));
const isEdited = (template, draft) => !!draft && (draft.subject !== template.subject || draft.body !== template.body);
// Server reasons don't always end in a full stop; the sentence after them needs one.
const sentence = (text) => { const t = String(text).trim(); return /[.!?…]$/.test(t) ? t : `${t}.`; };

function leaveMessage({ sending, saving, composing, edited }) {
  if (sending) return 'Your message is still sending. Stay here until it finishes.';
  if (saving) return 'An email is still saving. Stay here until it finishes.';
  if (composing && edited.length) return 'Your unsent message and your email changes haven’t been saved. Leaving discards them.';
  if (composing) return 'Your message hasn’t been sent. Leaving discards it.';
  if (edited.length === 1) return `Your changes to “${edited[0].label}” haven’t been saved. Leaving discards them.`;
  return `Your changes to ${edited.length} emails haven’t been saved. Leaving discards them.`;
}

export default function AdminNotifications() {
  const { user } = useAuth();
  const canWrite = can(user, 'notifications.write');
  const [tab, setTab] = useState('compose');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [history, setHistory] = useState({ messages: [], loaded: false, loading: false, error: '' });
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  // Edited template text by id, templates mid-save, and Compose's draft state.
  const [drafts, setDrafts] = useState({});
  const [savingTemplates, setSavingTemplates] = useState({});
  const [composeState, setComposeState] = useState(null);
  const headingRef = useRef(null);
  const historyTabRef = useRef(null);
  const composePanelRef = useRef(null);
  const focusHistoryTab = useRef(false);
  const retried = useRef(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminApi('GET', '/v1/admin/notifications'));
      setLoadError('');
    } catch (error) {
      setLoadError(problem(error, 'Try again in a moment.'));
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);
  // History keeps its last good list when a reload fails, and says so itself.
  const loadHistory = useCallback(async () => {
    setHistory((h) => ({ ...h, loading: true }));
    try {
      const { messages = [] } = await adminApi('GET', '/v1/admin/notifications/messages');
      setHistory({ messages, loaded: true, loading: false, error: '' });
    } catch (error) {
      setHistory((h) => ({ ...h, loading: false, error: problem(error, 'Try again in a moment.') }));
      throw error;
    }
  }, []);

  useEffect(() => {
    loadSettings().catch(() => {});
    loadHistory().catch(() => {});
  }, [loadSettings, loadHistory]);

  // Focus stays on Try again while it works and if it fails again. When the
  // page replaces the button, its heading takes the focus (as Customizer does).
  useLayoutEffect(() => {
    if (loading || !retried.current) return;
    retried.current = false;
    if (data && document.activeElement === document.body) headingRef.current?.focus();
  }, [loading, data]);

  // After a send, History opens on its tab; the Send button it replaces is hidden.
  useLayoutEffect(() => {
    if (tab !== 'history' || !focusHistoryTab.current) return;
    focusHistoryTab.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || composePanelRef.current?.contains(active)) historyTabRef.current?.focus();
  }, [tab]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    // A fresh look replaces earlier outcomes, so the result can be announced.
    setAnnouncement('');
    setNotice(null);
    const results = await Promise.allSettled([loadSettings(), loadHistory()]);
    setRefreshing(false);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) setNotice({ text: `Notifications could not be refreshed. ${problem(failed.reason, 'Try again in a moment.')}`, type: 'error' });
    else setAnnouncement('Notifications refreshed.');
  }

  const onSent = useCallback(async (switchTab = true) => {
    await loadHistory();
    if (switchTab) {
      focusHistoryTab.current = true;
      setTab('history');
    }
  }, [loadHistory]);
  const updateDraft = useCallback((template, draft) => setDrafts((current) => {
    const next = { ...current };
    if (isEdited(template, draft)) next[template.id] = draft;
    else delete next[template.id];
    return next;
  }), []);
  const templateSaved = useCallback((saved) => {
    setData((current) => ({ ...current, templates: current.templates.map((t) => (t.id === saved.id ? saved : t)) }));
    setDrafts((current) => {
      const next = { ...current };
      delete next[saved.id];
      return next;
    });
  }, []);
  const templateSaving = useCallback((id, saving) => setSavingTemplates((current) => ({ ...current, [id]: saving })), []);

  const edited = (data?.templates || []).filter((t) => isEdited(t, drafts[t.id]));
  const sending = composeState === 'sending';
  const saving = Object.values(savingTemplates).some(Boolean);
  const unsaved = sending || saving || composeState === 'draft' || edited.length > 0;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => unsaved
    && `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`);
  useEffect(() => {
    if (!unsaved) return undefined;
    const beforeUnload = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [unsaved]);
  // A navigation held while a save was in flight can go once that save lands.
  useEffect(() => {
    if (blocker.state === 'blocked' && !unsaved) blocker.proceed();
  }, [blocker, unsaved]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold focus-visible:outline-2 focus-visible:outline-ring">Notifications</h1>
        {data && (
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing} focusableWhenDisabled>
            {refreshing ? 'Refreshing…' : 'Refresh notifications'}
          </Button>
        )}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{notice?.text || announcement}</div>
      {!data ? (loadError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-4 py-3 text-sm text-danger-foreground" role="alert">
          <span>Notifications could not be loaded. {loadError}</span>
          <Button variant="outline" size="sm" disabled={loading} focusableWhenDisabled onClick={() => {
            retried.current = true;
            loadSettings().catch(() => {});
            loadHistory().catch(() => {});
          }}>{loading ? 'Retrying…' : 'Try again'}</Button>
        </div>
      ) : (
        <p className="py-12 text-center text-muted-foreground" role="status">Loading notifications…</p>
      )) : (
        <>
          {/* The status region above announces it; this is the visible copy. */}
          {notice && (
            <div className={`mb-4 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${notice.type === 'error' ? 'border-danger-border bg-danger text-danger-foreground' : 'border-success-border bg-success text-success-foreground'}`}>
              <p className="min-w-0 flex-1 self-center wrap-anywhere">{notice.text}</p>
              <Button variant="ghost" size="icon-sm" onClick={() => setNotice(null)} aria-label="Dismiss notification"><X aria-hidden="true" /></Button>
            </div>
          )}
          <Tabs value={tab} onValueChange={setTab} className="space-y-4">
            <TabsList aria-label="Notification sections">
              <TabsTrigger value="compose">Compose</TabsTrigger>
              <TabsTrigger value="automations">Automations</TabsTrigger>
              <TabsTrigger ref={historyTabRef} value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent ref={composePanelRef} value="compose" keepMounted>
              <Compose canWrite={canWrite} onNotice={setNotice} onSent={onSent} onDraftState={setComposeState} />
            </TabsContent>
            <TabsContent value="automations">
              <Automations data={data} canWrite={canWrite} onChange={setData} drafts={drafts}
                onDraft={updateDraft} onSaved={templateSaved} onSaving={templateSaving} />
            </TabsContent>
            <TabsContent value="history">
              <History history={history} canWrite={canWrite} onChanged={loadHistory} onNotice={setNotice} tabRef={historyTabRef} />
            </TabsContent>
          </Tabs>
        </>
      )}
      <AlertDialog open={blocker.state === 'blocked'} onOpenChange={(open) => { if (!open) blocker.reset?.(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>{leaveMessage({ sending, saving, composing: composeState === 'draft', edited })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay here</AlertDialogCancel>
            <Button disabled={sending || saving} focusableWhenDisabled onClick={() => blocker.proceed?.()}>Leave without saving</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Compose({ canWrite, onNotice, onSent, onDraftState }) {
  const [groups, setGroups] = useState([]);
  const [people, setPeople] = useState([]);
  // 'loading', 'ready' or 'error', so an empty list can say why it's empty.
  const [groupsState, setGroupsState] = useState('loading');
  const [peopleState, setPeopleState] = useState('loading');
  const [type, setType] = useState('all');
  const [group, setGroup] = useState('');
  const [roles, setRoles] = useState([]);
  const [selected, setSelected] = useState([]);
  const [query, setQuery] = useState('');
  const [inApp, setInApp] = useState(true);
  const [email, setEmail] = useState(false);
  const [important, setImportant] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [sending, setSending] = useState(false);
  // What became of the last send, shown beside Send while Compose stays open.
  const [status, setStatus] = useState(null);
  // One id per message: a retried send is recognized and not sent twice.
  const attempted = useRef(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    fetch('/v1/groups').then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((d) => { if (!cancelled) { setGroups(d.userGroups || []); setGroupsState('ready'); } })
      .catch(() => { if (!cancelled) setGroupsState('error'); });
    adminApi('GET', '/v1/admin/users')
      .then((list) => { if (!cancelled) { setPeople(list); setPeopleState('ready'); } })
      .catch(() => { if (!cancelled) setPeopleState('error'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    onDraftState(sending ? 'sending' : subject.trim() || body.trim() ? 'draft' : null);
  }, [sending, subject, body, onDraftState]);

  const audience = useMemo(() => (
    type === 'group' ? { type, group } : type === 'users' ? { type, userIds: selected }
      : type === 'role' ? { type, roles } : { type: 'all' }
  ), [type, group, selected, roles]);
  const audienceReady = type === 'all' || (type === 'role' && roles.length > 0) || (type === 'group' && group) || (type === 'users' && selected.length > 0);
  const audienceKey = JSON.stringify(audience);
  const toggleRole = (r) => setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  useEffect(() => {
    if (!audienceReady) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      adminApi('POST', '/v1/admin/notifications/preview', { audience })
        .then((data) => { if (!cancelled) setPreview({ audienceKey, audience, status: 'ready', data }); })
        .catch(() => { if (!cancelled) setPreview({ audienceKey, audience, status: 'error' }); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [audience, audienceKey, audienceReady]);

  // Matching during render invalidates a previous count before the effect or
  // debounce runs. A cancelled request can never authorize another audience.
  const currentPreview = audienceReady && preview?.audienceKey === audienceKey && preview.audience === audience ? preview : null;
  const count = currentPreview?.status === 'ready' ? currentPreview.data.count : null;
  const payload = { subject, body, inApp, email, important: inApp && important, audience };
  const fingerprint = JSON.stringify(payload);
  const draftFingerprint = useRef(fingerprint);
  useEffect(() => { draftFingerprint.current = fingerprint; }, [fingerprint]);
  const canSend = canWrite && !sending && audienceReady && subject.trim() && body.trim()
    && (inApp || email) && Number.isFinite(count) && count > 0;
  const confirmationCurrent = !!confirmation && !!canSend && confirmation.fingerprint === fingerprint
    && confirmation.audienceKey === audienceKey && confirmation.preview === currentPreview;

  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((p) => !q || `${p.name || ''} ${p.email}`.toLowerCase().includes(q));
  }, [people, query]);
  const matches = found.slice(0, 50);
  const groupsHint = groupsState === 'error' ? 'Groups couldn’t be loaded. Reload the page to try again.'
    : groupsState === 'ready' && !groups.length ? 'No groups yet. Add one under Users → Manage → User Groups.' : '';
  // Why Send is off, in the order the form asks. It's Send's description; the
  // audience count above covers a count that's pending, failed or zero.
  const sendReason = !canWrite ? 'Only admins can send messages.'
    : sending ? ''
      : type === 'role' && !roles.length ? 'Choose at least one role.'
        : type === 'group' && !group ? 'Choose a group.'
          : type === 'users' && !selected.length ? 'Choose at least one person.'
            : !inApp && !email ? 'Choose how to send it: in the classroom, by email, or both.'
              : !subject.trim() && !body.trim() ? 'Add a subject and a message.'
                : !subject.trim() ? 'Add a subject.'
                  : !body.trim() ? 'Add a message.' : '';
  const nameOf = (id) => { const p = people.find((x) => x.userId === id); return p ? (p.name || p.email) : id; };
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function send() {
    if (!confirmationCurrent) { setConfirmation(null); return; }
    const reviewed = confirmation;
    setConfirmation(null);
    setSending(true);
    setStatus(null);
    try {
      const { payload, fingerprint } = reviewed;
      const id = attempted.current && attempted.current.fingerprint !== fingerprint ? crypto.randomUUID() : requestId;
      attempted.current = { fingerprint, id };
      setRequestId(id);
      const result = await adminApi('POST', '/v1/admin/notifications/messages', { ...payload, requestId: id });
      if (result.message?.status === 'failed') throw Object.assign(new Error('Delivery failed.'), { created: true });
      setRequestId(crypto.randomUUID());
      attempted.current = null;
      const outcome = !payload.email ? 'Message sent to the classroom.'
        : payload.inApp ? 'Message sent to the classroom. History shows how each email went.'
          : 'Message processed. History shows how each email went.';
      const unchanged = draftFingerprint.current === fingerprint;
      const acknowledged = unchanged ? outcome : `“${payload.subject.trim()}” was sent. Your newer draft is kept.`;
      if (unchanged) { setSubject(''); setBody(''); setSelected([]); }
      try {
        // An unchanged draft moves on to History, which reports there; a newer
        // draft stays open here, with the earlier message's outcome beside Send.
        await onSent(unchanged);
        if (unchanged) onNotice({ text: acknowledged, type: 'success' });
        else setStatus({ text: acknowledged, type: 'success' });
      } catch (error) {
        // The POST is acknowledged. A failed read must not turn it back into
        // an unsent draft or encourage a second send under the next request ID.
        setStatus({ text: `${acknowledged} History could not be refreshed: ${problem(error, 'Try again in a moment.')} Use Refresh notifications to check it. Do not resend this message.`, type: 'error' });
      }
    } catch (e) {
      // A failed delivery still created the message: History can retry it, and
      // the unchanged draft resends under the same request ID. A request whose
      // outcome is unknown may have gone out, so History is where to check.
      const created = e.created || !!e.data?.message;
      const unknown = !created && !(e.status >= 400 && e.status < 500);
      const next = created ? ' Retry it from History, or send it again unchanged to retry the same message.'
        : unknown ? ' History shows anything already sent.' : '';
      setStatus({ text: `${sentence(problem(e, 'The message couldn’t be sent'))} Your draft is kept.${next}`, type: 'error' });
      await onSent(false).catch(() => {});
    } finally {
      setSending(false);
    }
  }

  const channels = [confirmation?.payload.inApp && 'in the classroom', confirmation?.payload.email && 'by email'].filter(Boolean).join(' and ');
  // Native choices, like Customizer's Match primary: the primary's color, one
  // size, aligned to the first line of a wrapped label, and 44 px rows on touch.
  const choice = 'touch-target flex cursor-pointer items-start gap-2 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:text-muted-foreground';
  const box = 'mt-0.5 size-4 shrink-0 accent-primary';

  return (
    <Card>
      {/* Any edit invalidates a reviewed confirmation. A send's error stays until
          the next send, so "Do not resend" can't vanish as someone retypes it. */}
      <CardContent className="space-y-5" onChange={() => { setConfirmation(null); setStatus((s) => (s?.type === 'error' ? s : null)); }}>
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium mb-1">To</legend>
          <label className={choice}><input type="radio" name="audience" className={box} checked={type === 'all'} onChange={() => setType('all')} /> Everyone</label>
          <label className={choice}><input type="radio" name="audience" className={box} checked={type === 'role'} onChange={() => setType('role')} /> By role</label>
          {type === 'role' && (
            <fieldset className="min-w-0 pl-6 space-y-1">
              <legend className="sr-only">Roles</legend>
              {ROLE_OPTIONS.map(([r, label]) => (
                <label key={r} className={choice}>
                  <input type="checkbox" className={box} checked={roles.includes(r)} onChange={() => toggleRole(r)} /> {label}
                </label>
              ))}
            </fieldset>
          )}
          <label className={choice}><input type="radio" name="audience" className={box} checked={type === 'group'} onChange={() => setType('group')} disabled={!groups.length} aria-describedby={groupsHint ? 'compose-groups-hint' : undefined} /> A group</label>
          {groupsHint && <p id="compose-groups-hint" className="pl-6 text-xs text-muted-foreground">{groupsHint}</p>}
          {type === 'group' && (
            <div className="pl-6">
              <Label htmlFor="compose-group" className="sr-only">Group</Label>
              {/* Shrinks below a long group name instead of spilling out of the card. */}
              <select id="compose-group" value={group} onChange={(e) => setGroup(e.target.value)} className="h-9 w-full max-w-full rounded-md border border-input bg-transparent px-3 text-sm sm:w-auto">
                <option value="">Choose a group</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          )}
          <label className={choice}><input type="radio" name="audience" className={box} checked={type === 'users'} onChange={() => setType('users')} /> Specific people</label>
          {type === 'users' && (
            <div className="pl-6 space-y-2">
              {selected.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Chosen people">
                  {selected.map((id) => (
                    <li key={id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs">
                      <span className="truncate">{nameOf(id)}</span>
                      {/* As in the Users invite list: a small mark with a 44 px touch area. */}
                      <button type="button" onClick={() => toggle(id)} aria-label={`Remove ${nameOf(id)}`}
                        className="compose-chip-remove inline-flex size-4 shrink-0 items-center justify-center rounded-full hover:text-destructive">
                        <X aria-hidden="true" className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Label htmlFor="compose-people-search">Find people</Label>
              <Input id="compose-people-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or email" />
              <ul className="max-h-48 overflow-y-auto overscroll-contain rounded-md border p-2 space-y-1" aria-label="People">
                {matches.map((p) => (
                  <li key={p.userId}>
                    <label className={choice}>
                      <input type="checkbox" className={box} checked={selected.includes(p.userId)} onChange={() => toggle(p.userId)} />
                      <span className="min-w-0 wrap-anywhere">{p.name ? <>{p.name} <span className="text-muted-foreground">{p.email}</span></> : p.email}</span>
                    </label>
                  </li>
                ))}
                {matches.length === 0 && (
                  <li className="text-sm text-muted-foreground">
                    {peopleState === 'loading' ? 'Loading people…' : peopleState === 'error' ? 'People couldn’t be loaded. Reload the page to try again.' : 'No one matches.'}
                  </li>
                )}
              </ul>
              {found.length > matches.length && <p className="text-xs text-muted-foreground">Showing {matches.length} of {found.length}. Search by name or email to find anyone else.</p>}
            </div>
          )}
        </fieldset>

        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium mb-1">How</legend>
          <label className={choice}><input type="checkbox" className={box} checked={inApp} onChange={(e) => setInApp(e.target.checked)} /> In the classroom (the bell menu)</label>
          {inApp && (
            <label className={`${choice} pl-6`}><input type="checkbox" className={box} checked={important} onChange={(e) => setImportant(e.target.checked)} /> Also show it as a pop-up the next time they open the classroom</label>
          )}
          <label className={choice}><input type="checkbox" className={box} checked={email} onChange={(e) => setEmail(e.target.checked)} /> By email</label>
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor="compose-subject">Subject</Label>
          <Input id="compose-subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="compose-body">Message</Label>
          <Textarea id="compose-body" rows={6} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} aria-describedby="compose-body-hint" />
          <p id="compose-body-hint" className="text-xs text-muted-foreground">You can use {vars(MESSAGE_VARIABLES)}. A blank line starts a new paragraph.</p>
        </div>

        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {count == null ? (currentPreview?.status === 'error' ? 'Couldn’t count this audience. Choose it again to retry.' : '') : `Goes to ${peopleCount(count)}${email && currentPreview.data.emailOptedOut ? `; ${currentPreview.data.emailOptedOut} turned off email` : ''}.`}
        </p>
        <div className="space-y-2">
          <Button onClick={() => {
            if (canSend) setConfirmation({ payload: structuredClone(payload), fingerprint, audienceKey, count, preview: currentPreview });
          }} disabled={!canSend} focusableWhenDisabled aria-describedby={sendReason ? 'compose-send-reason' : undefined}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
          {sendReason && <p id="compose-send-reason" className="text-sm text-muted-foreground">{sendReason}</p>}
          <p role="status" aria-live="polite" className={`text-sm wrap-anywhere ${toneOf(status)}`}>{status?.text || ''}</p>
        </div>
      </CardContent>
      <ConfirmModal
        open={confirmationCurrent}
        onOpenChange={(open) => { if (!open) setConfirmation(null); }}
        title={`Send to ${peopleCount(confirmation?.count || 0)}?`}
        message={`“${confirmation?.payload.subject.trim() || ''}” goes out ${channels} now. It can’t be unsent.`}
        confirmLabel="Send"
        variant="default"
        onConfirm={send}
      />
    </Card>
  );
}

function Automations({ data, canWrite, onChange, drafts, onDraft, onSaved, onSaving }) {
  const templates = Object.fromEntries((data.templates || []).map((t) => [t.id, t]));
  const [pending, setPending] = useState({});
  const [failures, setFailures] = useState({});
  // The newest request per automation wins, however the responses arrive.
  const latest = useRef({});
  async function toggle(key, on) {
    const request = (latest.current[key] || 0) + 1;
    latest.current[key] = request;
    const label = templates[AUTOMATION_TEMPLATE[key]]?.label || 'This email';
    // Optimistic, so the switch answers at once; put back on failure. The
    // switch announces its own state, so only a failure needs words.
    onChange((current) => ({ ...current, automations: { ...current.automations, [key]: on } }));
    setPending((current) => ({ ...current, [key]: true }));
    setFailures((current) => ({ ...current, [key]: '' }));
    try {
      const { automations } = await adminApi('PUT', '/v1/admin/notifications/automations', { [key]: on });
      if (latest.current[key] !== request) return;
      onChange((current) => ({ ...current, automations: { ...current.automations, [key]: !!automations?.[key] } }));
    } catch (error) {
      if (latest.current[key] !== request) return;
      onChange((current) => ({ ...current, automations: { ...current.automations, [key]: !on } }));
      const failure = `${label} is still ${on ? 'off' : 'on'}. ${sentence(problem(error, 'The change couldn’t be saved'))}`;
      setFailures((current) => ({ ...current, [key]: failure }));
    } finally {
      if (latest.current[key] === request) setPending((current) => ({ ...current, [key]: false }));
    }
  }
  const items = [
    ...(data.alwaysOn || ALWAYS_ON).map((id) => ({ template: templates[id] })),
    ...AVAILABLE.map((key) => ({ template: templates[AUTOMATION_TEMPLATE[key]], key })),
  ].filter((item) => item.template);
  return (
    <div className="space-y-4">
      <p className="max-w-md text-sm text-muted-foreground">Emails plato sends on its own. Invitation emails are always on; the others stay off until you turn them on. Whether an email is actually delivered depends on this site’s email setup.</p>
      {items.map(({ template: t, key }) => {
        const on = !!data.automations?.[key];
        return (
          // The disclosure row closes each card, so it carries the bottom padding.
          <Card key={t.id} className="pb-2">
            {/* Name, trigger and state, laid out like a plugin card. */}
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-48">
                  <CardTitle as="h2">{t.label}</CardTitle>
                  <p className="mt-1 max-w-md text-sm text-muted-foreground">{t.description}</p>
                  {/* Always present, so a failure is announced; empty, it takes no space. */}
                  {key && <p role="status" aria-live="polite" className="max-w-md text-sm text-destructive not-empty:mt-1">{failures[key] || ''}</p>}
                </div>
                {key ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`text-xs font-medium ${on ? 'text-foreground' : 'text-muted-foreground'}`}>{pending[key] ? 'Saving…' : on ? 'On' : 'Off'}</span>
                    <Switch checked={on} onCheckedChange={(next) => toggle(key, next)} disabled={!canWrite} label={`${t.label} email`} />
                  </div>
                ) : (
                  <span className="shrink-0 text-xs font-medium">Always on</span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <TemplateEditor template={t} draft={drafts[t.id]} canWrite={canWrite} onDraft={onDraft} onSaved={onSaved} onSaving={onSaving} />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// The email's copy, behind a disclosure so the tab reads as a list of emails.
// Its text is a draft held by the page, so leaving the tab keeps it; an email
// with unsaved changes opens again on return.
function TemplateEditor({ template, draft, canWrite, onDraft, onSaved, onSaving }) {
  const id = template.id;
  const subject = draft?.subject ?? template.subject;
  const body = draft?.body ?? template.body;
  const dirty = isEdited(template, draft);
  const [open, setOpen] = useState(dirty);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(null);
  const working = useRef('');
  const testButton = useRef(null);
  const focusTestAfterReset = useRef(false);
  const locked = busy === 'save' || busy === 'reset';

  const edit = (field) => (event) => {
    onDraft(template, { subject, body, [field]: event.target.value });
    setStatus(null);
  };
  async function run(kind, task) {
    if (working.current) return;
    working.current = kind;
    setBusy(kind);
    setStatus(null);
    const saves = kind !== 'test';
    if (saves) onSaving(id, true);
    try {
      await task();
    } catch (error) {
      setStatus({ text: problem(error, kind === 'test' ? 'The test email couldn’t be sent.' : 'The email couldn’t be saved.'), type: 'error' });
    } finally {
      working.current = '';
      setBusy('');
      if (saves) onSaving(id, false);
    }
  }
  const save = () => run('save', async () => {
    const { template: next } = await adminApi('PUT', `/v1/admin/notifications/templates/${id}`, { subject, body });
    onSaved(next);
    setStatus({ text: 'Email saved.', type: 'success' });
  });
  const reset = () => run('reset', async () => {
    const { template: next } = await adminApi('DELETE', `/v1/admin/notifications/templates/${id}`);
    focusTestAfterReset.current = true;
    onSaved(next);
    setStatus({ text: 'Back to plato’s default email.', type: 'success' });
  });
  const test = () => run('test', async () => {
    const r = await adminApi('POST', `/v1/admin/notifications/templates/${id}/test`, { subject, body });
    setStatus({ text: r.sent ? `Test sent to ${r.to}.` : r.blocked ? `Not sent: ${r.to} isn’t on this site’s email allowlist.` : `Email is turned off here, so nothing was sent to ${r.to}.`, type: r.sent ? 'success' : 'error' });
  });
  // Use the default leaves once the email is plato's default again. The test
  // send, the action that remains, takes the focus it had.
  useLayoutEffect(() => {
    if (!template.isDefault || !focusTestAfterReset.current) return;
    focusTestAfterReset.current = false;
    if (document.activeElement === document.body) testButton.current?.focus();
  }, [template.isDefault]);

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group/editor border-t border-border pt-2">
      <summary className="touch-target flex min-h-10 w-fit cursor-pointer list-none items-center gap-2 rounded-sm text-sm font-medium hover:text-link [&::-webkit-details-marker]:hidden">
        {canWrite ? 'Edit email' : 'View email'}<span className="sr-only">: {template.label}</span>
        <ChevronDown aria-hidden="true" className="size-4 transition-transform duration-150 group-open/editor:rotate-180 motion-reduce:transition-none" />
        {dirty && <span className="font-normal text-muted-foreground group-open/editor:hidden">Unsaved changes</span>}
      </summary>
      <div className="space-y-3 pb-2 pt-2">
        <div className="space-y-2">
          <Label htmlFor={`${id}-subject`}>Subject</Label>
          <Input id={`${id}-subject`} value={subject} maxLength={200} disabled={!canWrite} readOnly={locked} onChange={edit('subject')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-body`}>Message</Label>
          <Textarea id={`${id}-body`} rows={7} value={body} maxLength={5000} disabled={!canWrite} readOnly={locked} onChange={edit('body')} aria-describedby={`${id}-hint`} />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            You can use {vars(template.variables)}.{template.variables.includes('link') ? ' Put {{link}} on its own line for a button.' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={save} disabled={!canWrite || !dirty || !!busy} focusableWhenDisabled>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
          <Button ref={testButton} size="sm" variant="outline" onClick={test} disabled={!canWrite || !!busy} focusableWhenDisabled>{busy === 'test' ? 'Sending…' : 'Send a test to me'}</Button>
          {!template.isDefault && <Button size="sm" variant="ghost" onClick={reset} disabled={!canWrite || !!busy} focusableWhenDisabled>{busy === 'reset' ? 'Restoring…' : 'Use the default'}</Button>}
          <p role="status" aria-live="polite" className={`min-w-0 text-sm wrap-anywhere ${toneOf(status)}`}>{status?.text || (dirty ? 'Unsaved changes' : '')}</p>
        </div>
      </div>
    </details>
  );
}

const ROLE_LABEL = Object.fromEntries(ROLE_OPTIONS);
// Older "everyone" and group messages (no allRoles) went to learners only.
function audienceLabel(a = {}) {
  if (a.type === 'all') return a.allRoles ? 'Everyone' : 'All learners';
  if (a.type === 'role') return `Roles: ${(a.roles || []).map((r) => ROLE_LABEL[r] || r).join(', ')}`;
  if (a.type === 'group') return `Group: ${a.group}${a.allRoles ? '' : ' (learners)'}`;
  if (a.type === 'users') return `People (${(a.userIds || []).length})`;
  return '';
}

function sentAt(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// What one row of History shows, for the table and the narrow list alike.
function messageView(m) {
  const c = m.counts || {};
  return {
    recipients: peopleCount(c.recipients ?? 0),
    how: [m.inApp && 'Classroom', m.email && 'Email'].filter(Boolean).join(', '),
    emailLine: m.email
      ? (m.status === 'sending' ? 'Emailing…' : `${c.emailed ?? 0} emailed${c.optedOut ? `, ${c.optedOut} opted out` : ''}${c.blocked ? `, ${c.blocked} not allowlisted` : ''}${c.failed ? `, ${c.failed} failed` : ''}${c.skipped ? `, ${c.skipped} not sent (email delivery disabled)` : ''}${c.pending ? `, ${c.pending} pending confirmation` : ''}`)
      : null,
    status: m.status === 'closed' ? 'Retries stopped' : m.status === 'failed' ? 'Delivery failed' : m.status === 'sending' ? 'Sending' : 'Processed',
    actionable: ['failed', 'sending'].includes(m.status),
  };
}

function Detail({ label, children }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

function History({ history, canWrite, onChanged, onNotice, tabRef }) {
  const narrow = useMediaQuery(NARROW);
  const [retrying, setRetrying] = useState(null);
  const [closing, setClosing] = useState(null);
  const [closeTarget, setCloseTarget] = useState(null);
  const container = useRef(null);
  const returnTo = useRef(null);
  const reloaded = useRef(false);
  const { messages, loaded, loading, error: loadError } = history;

  async function retry(message) {
    if (retrying) return;
    returnTo.current = message.id;
    setRetrying(message.id);
    try {
      const result = await adminApi('POST', `/v1/admin/notifications/messages/${encodeURIComponent(message.id)}/retry`);
      onNotice({ text: result.message?.status === 'sending' ? 'Still delivering. Use Refresh notifications in a moment to see how it went.' : 'Retry finished. History shows how it went.', type: 'success' });
    } catch (error) { onNotice({ text: problem(error, 'The retry couldn’t be started.'), type: 'error' }); }
    finally { await onChanged().catch(() => {}); setRetrying(null); }
  }
  async function stopRetrying() {
    const message = closeTarget;
    if (!message || retrying || closing) return;
    returnTo.current = message.id;
    setClosing(message.id);
    try {
      await adminApi('POST', `/v1/admin/notifications/messages/${encodeURIComponent(message.id)}/close`);
      onNotice({ text: `Retries stopped for “${message.subject}”.`, type: 'success' });
    } catch (error) { onNotice({ text: problem(error, 'Retries couldn’t be stopped.'), type: 'error' }); }
    finally { await onChanged().catch(() => {}); setClosing(null); }
  }
  // A retry or Stop retrying that settles a message removes its actions. Focus
  // then goes to what remains of that message: its new status.
  useLayoutEffect(() => {
    const id = returnTo.current;
    if (!id || retrying || closing || closeTarget) return;
    returnTo.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const row = [...(container.current?.querySelectorAll('[data-message-id]') || [])].find((el) => el.dataset.messageId === id);
    (row?.querySelector('[data-message-action]') || row?.querySelector('[data-message-status]'))?.focus();
  }, [retrying, closing, closeTarget, messages]);
  // Try again keeps focus while it works; once History loads, its tab takes it.
  useLayoutEffect(() => {
    if (loading || !reloaded.current) return;
    reloaded.current = false;
    if (!loadError && document.activeElement === document.body) tabRef.current?.focus();
  }, [loading, loadError, tabRef]);

  if (!loaded && !loadError) return <p className="py-6 text-sm text-muted-foreground" role="status">Loading sent messages…</p>;
  const failure = loadError && (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-4 py-3 text-sm text-danger-foreground" role="alert">
      <span>Sent messages could not be {messages.length ? 'refreshed' : 'loaded'}. {loadError}</span>
      <Button variant="outline" size="sm" disabled={loading} focusableWhenDisabled onClick={() => { reloaded.current = true; onChanged().catch(() => {}); }}>
        {loading ? 'Retrying…' : 'Try again'}
      </Button>
    </div>
  );
  if (!messages.length) return failure || (
    <div className="rounded-lg border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">Nothing sent yet. Messages you send from Compose appear here.</div>
  );

  const status = (m, view, className = '') => (
    <span data-message-status tabIndex={-1} className={`rounded-sm ${m.status === 'failed' ? 'text-destructive' : ''} ${className}`}>{view.status}</span>
  );
  const actions = (m, view) => canWrite && view.actionable && (
    <div className="mt-2 flex flex-wrap gap-2">
      <Button data-message-action size="sm" variant="outline" disabled={!!retrying || !!closing} focusableWhenDisabled onClick={() => retry(m)}>{retrying === m.id ? 'Retrying…' : 'Retry delivery'}</Button>
      <Button size="sm" variant="outline" disabled={!!retrying || !!closing} focusableWhenDisabled onClick={() => setCloseTarget(m)}>{closing === m.id ? 'Stopping…' : 'Stop retrying'}</Button>
    </div>
  );

  return (
    <div ref={container} className="space-y-4">
      {failure}
      {narrow ? (
        <ul aria-label="Sent messages" className="divide-y divide-border border-y border-border">
          {messages.map((m) => {
            const view = messageView(m);
            return (
              <li key={m.id} data-message-id={m.id} className="space-y-2 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 font-medium wrap-anywhere">{m.subject}</p>
                  {status(m, view, 'shrink-0 text-sm font-medium')}
                </div>
                <p className="text-sm text-muted-foreground">
                  Sent <time dateTime={m.createdAt}>{sentAt(m.createdAt)}</time>{m.createdByName && <> by {m.createdByName}</>}{m.important && <> · Pop-up</>}
                </p>
                <dl className="space-y-1 text-sm">
                  <Detail label="To">{audienceLabel(m.audience)}</Detail>
                  <Detail label="How">{view.how}</Detail>
                  <Detail label="Recipients">{view.recipients}{view.emailLine && <span className="block text-muted-foreground">{view.emailLine}</span>}</Detail>
                </dl>
                {m.deliveryError && <p className="text-sm text-muted-foreground wrap-anywhere">{m.deliveryError}</p>}
                {actions(m, view)}
              </li>
            );
          })}
        </ul>
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table aria-label="Sent messages">
            <TableHeader>
              <TableRow>
                <TableHead>Sent</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>To</TableHead>
                <TableHead>How</TableHead>
                <TableHead>Recipients</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.map((m) => {
                const view = messageView(m);
                // Cells wrap, so Status and its actions stay on screen.
                return (
                  <TableRow key={m.id} data-message-id={m.id}>
                    <TableCell className="align-top"><time dateTime={m.createdAt}>{sentAt(m.createdAt)}</time><span className="block text-xs text-muted-foreground">{m.createdByName}</span></TableCell>
                    <TableCell className="min-w-40 align-top whitespace-normal wrap-anywhere">{m.subject}{m.important && <span className="block text-xs text-muted-foreground">Pop-up</span>}</TableCell>
                    <TableCell className="align-top whitespace-normal">{audienceLabel(m.audience)}</TableCell>
                    <TableCell className="align-top whitespace-normal">{view.how}</TableCell>
                    <TableCell className="align-top whitespace-normal">{view.recipients}{view.emailLine && <span className="block text-xs text-muted-foreground">{view.emailLine}</span>}</TableCell>
                    <TableCell className="min-w-36 align-top whitespace-normal">
                      {status(m, view)}
                      {m.deliveryError && <p className="text-xs text-muted-foreground wrap-anywhere">{m.deliveryError}</p>}
                      {actions(m, view)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      <ConfirmModal open={!!closeTarget} onOpenChange={open => { if (!open) setCloseTarget(null); }}
        title="Stop retrying this message?" confirmLabel="Stop retrying"
        message={`plato won’t try to email “${closeTarget?.subject || ''}” again.${closeTarget?.inApp ? ' People can still read it in the classroom.' : ''}`}
        onConfirm={stopRetrying} />
    </div>
  );
}
