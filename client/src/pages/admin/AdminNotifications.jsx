import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useBlocker } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
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
          {notice && (
            <div className={`flex items-center justify-between rounded-lg px-4 py-3 mb-4 text-sm ${notice.type === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-success text-success-foreground'}`}>
              <span>{notice.text}</span>
              <button onClick={() => setNotice(null)} aria-label="Dismiss" className="ml-2 text-lg leading-none hover:opacity-70">&times;</button>
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
    fetch('/v1/groups').then((r) => r.json()).then((d) => { if (!cancelled) setGroups(d.userGroups || []); }).catch(() => {});
    adminApi('GET', '/v1/admin/users').then((list) => { if (!cancelled) setPeople(list); }).catch(() => {});
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

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people
      .filter((p) => !q || `${p.name || ''} ${p.email}`.toLowerCase().includes(q))
      .slice(0, 50);
  }, [people, query]);
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
      if (result.message?.status === 'failed') throw new Error('Delivery failed. Your message is in History; retry it there or retry this same request.');
      setRequestId(crypto.randomUUID());
      attempted.current = null;
      const outcome = payload.email ? 'Message processed. History shows email delivery outcomes, including delivery disabled or failed.' : 'Message sent to the classroom.';
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
      setStatus({ text: `${problem(e, 'The message could not be sent.')} Your draft is retained. History shows any delivery attempt already created.`, type: 'error' });
      await onSent(false).catch(() => {});
    } finally {
      setSending(false);
    }
  }

  const channels = [confirmation?.payload.inApp && 'in the classroom', confirmation?.payload.email && 'by email'].filter(Boolean).join(' and ');
  const radio = 'flex items-center gap-2 text-sm';

  return (
    <Card>
      {/* Any edit invalidates a reviewed confirmation. A send's error stays until
          the next send, so "Do not resend" can't vanish as someone retypes it. */}
      <CardContent className="space-y-5" onChange={() => { setConfirmation(null); setStatus((s) => (s?.type === 'error' ? s : null)); }}>
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium mb-1">To</legend>
          <label className={radio}><input type="radio" name="audience" className="accent-primary" checked={type === 'all'} onChange={() => setType('all')} /> Everyone</label>
          <label className={radio}><input type="radio" name="audience" className="accent-primary" checked={type === 'role'} onChange={() => setType('role')} /> By role</label>
          {type === 'role' && (
            <fieldset className="min-w-0 pl-6 space-y-1">
              <legend className="sr-only">Roles</legend>
              {ROLE_OPTIONS.map(([r, label]) => (
                <label key={r} className={radio}>
                  <input type="checkbox" className="h-4 w-4" checked={roles.includes(r)} onChange={() => toggleRole(r)} /> {label}
                </label>
              ))}
            </fieldset>
          )}
          <label className={radio}><input type="radio" name="audience" className="accent-primary" checked={type === 'group'} onChange={() => setType('group')} disabled={!groups.length} /> A group</label>
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
          <label className={radio}><input type="radio" name="audience" className="accent-primary" checked={type === 'users'} onChange={() => setType('users')} /> Specific people</label>
          {type === 'users' && (
            <div className="pl-6 space-y-2">
              {selected.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Chosen people">
                  {selected.map((id) => (
                    <li key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs">
                      {nameOf(id)}
                      <button type="button" onClick={() => toggle(id)} aria-label={`Remove ${nameOf(id)}`} className="leading-none hover:opacity-70">&times;</button>
                    </li>
                  ))}
                </ul>
              )}
              <Label htmlFor="compose-people-search">Find people</Label>
              <Input id="compose-people-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or email" />
              <ul className="max-h-48 overflow-y-auto rounded-md border p-2 space-y-1" aria-label="People">
                {matches.map((p) => (
                  <li key={p.userId}>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="h-4 w-4" checked={selected.includes(p.userId)} onChange={() => toggle(p.userId)} />
                      <span>{p.name || p.email} <span className="text-muted-foreground">{p.email}</span></span>
                    </label>
                  </li>
                ))}
                {matches.length === 0 && <li className="text-sm text-muted-foreground">No one matches.</li>}
              </ul>
            </div>
          )}
        </fieldset>

        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium mb-1">How</legend>
          <label className={radio}><input type="checkbox" className="h-4 w-4" checked={inApp} onChange={(e) => setInApp(e.target.checked)} /> In the classroom (the bell menu)</label>
          {inApp && (
            <label className={`${radio} pl-6`}><input type="checkbox" className="h-4 w-4" checked={important} onChange={(e) => setImportant(e.target.checked)} /> Also show it as a pop-up the next time they open the classroom</label>
          )}
          <label className={radio}><input type="checkbox" className="h-4 w-4" checked={email} onChange={(e) => setEmail(e.target.checked)} /> By email</label>
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
          {count == null ? (currentPreview?.status === 'error' ? 'Could not preview this audience.' : '') : `Goes to ${peopleCount(count)}${email && currentPreview.data.emailOptedOut ? `; ${currentPreview.data.emailOptedOut} turned off email` : ''}.`}
        </p>
        <div className="space-y-2">
          <Button onClick={() => {
            if (canSend) setConfirmation({ payload: structuredClone(payload), fingerprint, audienceKey, count, preview: currentPreview });
          }} disabled={!canSend} focusableWhenDisabled>
            {sending ? 'Sending…' : 'Send'}
          </Button>
          <p role="status" aria-live="polite" className={`text-sm wrap-anywhere ${toneOf(status)}`}>{status?.text || ''}</p>
        </div>
        {!canWrite && <p className="text-xs text-muted-foreground">Only admins can send messages.</p>}
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
  const [switchStatus, setSwitchStatus] = useState({});
  // The newest request per automation wins, however the responses arrive.
  const latest = useRef({});
  async function toggle(key, on) {
    const request = (latest.current[key] || 0) + 1;
    latest.current[key] = request;
    const label = templates[AUTOMATION_TEMPLATE[key]]?.label || 'This email';
    // Optimistic, so the checkbox answers at once; put back on failure.
    onChange((current) => ({ ...current, automations: { ...current.automations, [key]: on } }));
    setSwitchStatus((current) => ({ ...current, [key]: null }));
    try {
      const { automations } = await adminApi('PUT', '/v1/admin/notifications/automations', { [key]: on });
      if (latest.current[key] !== request) return;
      const saved = !!automations?.[key];
      onChange((current) => ({ ...current, automations: { ...current.automations, [key]: saved } }));
      setSwitchStatus((current) => ({ ...current, [key]: { text: `${label} is ${saved ? 'on' : 'off'}.`, type: 'success' } }));
    } catch (error) {
      if (latest.current[key] !== request) return;
      onChange((current) => ({ ...current, automations: { ...current.automations, [key]: !on } }));
      setSwitchStatus((current) => ({ ...current, [key]: { text: problem(error, `${label} couldn’t be turned ${on ? 'on' : 'off'}.`), type: 'error' } }));
    }
  }
  const items = [
    ...(data.alwaysOn || ALWAYS_ON).map((id) => ({ template: templates[id] })),
    ...AVAILABLE.map((key) => ({ template: templates[AUTOMATION_TEMPLATE[key]], key })),
  ].filter((item) => item.template);
  return (
    <div className="space-y-4">
      <p className="max-w-md text-sm text-muted-foreground">Emails plato sends on its own. Invitation templates are always enabled; actual email delivery depends on this site’s email configuration; each of the others is off until you turn it on.</p>
      {items.map(({ template: t, key }) => (
        // The disclosure row closes each card, so it carries the bottom padding.
        <Card key={t.id} className="pb-2">
          <CardHeader>
            <CardTitle as="h2">{t.label}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="max-w-md text-sm text-muted-foreground">{t.description}</p>
            {key ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="h-4 w-4" checked={!!data.automations?.[key]} disabled={!canWrite} onChange={(e) => toggle(key, e.target.checked)} />
                  Send the {t.label.toLowerCase()} email
                </label>
                <span role="status" aria-live="polite" className={`text-sm ${toneOf(switchStatus[key])}`}>{switchStatus[key]?.text || ''}</span>
              </div>
            ) : (
              <p className="text-sm font-medium">Always on</p>
            )}
            <TemplateEditor template={t} draft={drafts[t.id]} canWrite={canWrite} onDraft={onDraft} onSaved={onSaved} onSaving={onSaving} />
          </CardContent>
        </Card>
      ))}
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
    status: m.status === 'closed' ? 'Closed' : m.status === 'failed' ? 'Delivery failed' : m.status === 'sending' ? 'Sending' : 'Processed',
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
      onNotice({ text: result.message?.status === 'sending' ? 'Delivery is still in progress. Refresh History shortly.' : 'Retry processed. History shows the delivery outcomes.', type: 'success' });
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
  });
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
  if (!messages.length) return failure || <p className="text-sm text-muted-foreground">Nothing sent yet.</p>;

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
                  <Detail label="Delivered">{view.recipients}{view.emailLine && <span className="block text-muted-foreground">{view.emailLine}</span>}</Detail>
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
                <TableHead>Delivered</TableHead>
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
        message={`“${closeTarget?.subject || ''}” will receive no further email delivery attempts.${closeTarget?.inApp ? ' People can still read it in the classroom.' : ''}`}
        onConfirm={stopRetrying} />
    </div>
  );
}
