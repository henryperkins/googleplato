import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { adminApi } from './adminApi.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { PluginSlot } from '@/lib/plugins/Slot.jsx';
import UserStatsPanel from './UserStatsPanel.jsx';
import CompletionRing from './CompletionRing.jsx';
import UserFieldsDialog from './UserFieldsDialog.jsx';
import WaitlistDialog from './WaitlistDialog.jsx';
import WaitlistEntryEdit from './WaitlistEntryEdit.jsx';
import CustomFieldInput from '../../components/CustomFieldInput.jsx';
import ConfirmModal from '../../components/modals/ConfirmModal.jsx';
import CopyLinkField from '../../components/CopyLinkField.jsx';
import { customFieldsMatch, matchesFieldFilter, missingRequired } from '../../lib/userFields.js';
import { describeBulkInvites, describeSingleInvite, describeAdminReset } from '../../lib/inviteResults.js';

const PAGE_SIZE = 20;

const SORT_LABELS = {
  name: 'name', email: 'email', username: 'username',
  group: 'group', role: 'role', completed: 'completion',
  lastActive: 'last active', date: 'join date',
};

// Module-level so the function references are stable across renders, which
// lets sortedList's useMemo cache correctly (and gets rid of the
// eslint-disable on exhaustive-deps). Items are the wrapper rows from
// combinedList — see _user for the underlying user record.
const SORT_KEY_FNS = {
  name: (i) => i.name || i.email || '',
  email: (i) => i.email || '',
  username: (i) => i.username || '',
  group: (i) => i.userGroup || '',
  role: (i) => i.role || '',
  completed: (i) => {
    const c = i._user?.lessonsCompleted;
    const a = i._user?.lessonsAvailable;
    if (typeof c !== 'number' || typeof a !== 'number' || a <= 0) return null;
    return c / a;
  },
  lastActive: (i) => i._user?.lastActiveAt || null,
  date: (i) => i.createdAt || '',
};

function SortHeader({ sortKey, sortBy, onSort, align = 'left', children }) {
  const active = sortBy.key === sortKey;
  const aria = !active ? 'none' : sortBy.dir === 'asc' ? 'ascending' : 'descending';
  const cellAlign = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : '';
  const btnAlign = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center w-full' : '';
  return (
    <TableHead aria-sort={aria} className={cellAlign}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`touch-target inline-flex items-center gap-1 font-medium hover:text-foreground rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 ${btnAlign}`}
      >
        {children}
        {/* Unsorted columns show a muted arrow, not a near-invisible one. */}
        <span aria-hidden="true" className={`text-xs ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
          {active ? (sortBy.dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </TableHead>
  );
}

function parseCsvEmails(text) {
  const lines = text.split(/\r?\n/);
  const emails = [];
  const headerLine = lines[0] || '';
  const headers = headerLine.split(',').map(h => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
  const emailCol = headers.indexOf('email');
  for (let i = emailCol >= 0 ? 1 : 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let value;
    if (emailCol >= 0) {
      const cols = line.split(',');
      value = (cols[emailCol] || '').trim().replace(/^["']|["']$/g, '');
    } else {
      value = line.replace(/^["']|["']$/g, '').trim();
    }
    if (value) emails.push(value.toLowerCase());
  }
  return emails;
}

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function AdminUsers() {
  const navigate = useNavigate();
  const { userId: paramUserId, waitlistToken } = useParams();
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [waitlistEntries, setWaitlistEntries] = useState([]);
  const [waitlistSettings, setWaitlistSettings] = useState({ open: false, hasApiKey: false });
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  // Only the first load replaces the page with a spinner; refreshes after an
  // invite, delete, or edit keep the page (and any open dialog) mounted.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  // Unknown is not "none": a failed status fetch must not make Generate or
  // Make a key look safe, since both replace a live credential.
  const [linkLoadFailed, setLinkLoadFailed] = useState(false);
  const [waitlistLoadFailed, setWaitlistLoadFailed] = useState(false);
  const [message, setMessage] = useState(null);

  // Modal states
  const [inviteOpen, setInviteOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  const [userFields, setUserFields] = useState([]);
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', email: '', username: '', userGroup: '', role: '', customFields: {} });

  // Invite modal state
  const [inviteInput, setInviteInput] = useState('');
  const [emailQueue, setEmailQueue] = useState([]);
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteNotice, setInviteNotice] = useState(null);
  const [inviteLinks, setInviteLinks] = useState([]);
  const csvRef = useRef(null);

  // Search, filter, pagination
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  // Custom-field filter (#364): { fieldId, value } — value is '__set', '__empty', or a dropdown option.
  const [fieldFilter, setFieldFilter] = useState({ fieldId: '', value: '' });
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState({ key: 'name', dir: 'asc' });
  const [sortAnnouncement, setSortAnnouncement] = useState('');

  // Groups form
  const [newGroupName, setNewGroupName] = useState('');

  // Slack integration state
  const [slackConnected, setSlackConnected] = useState(false);
  const [inviteTab, setInviteTab] = useState('email');
  const [slackSearch, setSlackSearch] = useState('');
  const [slackSearchResults, setSlackSearchResults] = useState([]);
  const [slackSearching, setSlackSearching] = useState(false);
  const [slackChannels, setSlackChannels] = useState([]);
  const [slackSelectedChannel, setSlackSelectedChannel] = useState('');
  const [slackQueue, setSlackQueue] = useState([]);
  const [slackSending, setSlackSending] = useState(false);

  // Link invite state
  const [linkInvite, setLinkInvite] = useState(null);
  const [linkGenerating, setLinkGenerating] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, invitesRes, settingsRes, pluginsRes, linkRes, waitlistRes] = await Promise.all([
        adminApi('GET', '/v1/admin/users?include=stats'),
        adminApi('GET', '/v1/admin/invites'),
        adminApi('GET', '/v1/admin/settings'),
        adminApi('GET', '/v1/admin/plugins').catch(() => []),
        adminApi('GET', '/v1/admin/invites/link').then((data) => ({ ok: true, data }), () => ({ ok: false })),
        adminApi('GET', '/v1/admin/waitlist').then((data) => ({ ok: true, data }), () => ({ ok: false })),
      ]);
      setUsers(Array.isArray(usersRes) ? usersRes : []);
      setPendingInvites(Array.isArray(invitesRes) ? invitesRes.filter(x => x.status === 'pending') : []);
      setGroups(settingsRes.userGroups || []);
      setUserFields(Array.isArray(settingsRes.userFields) ? settingsRes.userFields : []);
      setLinkLoadFailed(!linkRes.ok);
      if (linkRes.ok) setLinkInvite(linkRes.data);
      setWaitlistLoadFailed(!waitlistRes.ok);
      if (waitlistRes.ok) {
        const waitlist = waitlistRes.data;
        setWaitlistEntries(Array.isArray(waitlist?.entries) ? waitlist.entries : []);
        setWaitlistSettings({ open: !!waitlist?.open, hasApiKey: !!waitlist?.hasApiKey });
      }
      // Slack connection status comes from the plugin's settings, not legacy _system:settings.slack.
      // The Slack tab is hidden when the plugin is disabled OR not connected.
      const slack = Array.isArray(pluginsRes) ? pluginsRes.find((entry) => entry.id === 'slack') : null;
      setSlackConnected(!!(slack?.enabled && slack?.settings?.connected));
      setLoadError(null);
    } catch (e) {
      setLoadError(e?.message || 'Users could not be loaded.');
    }
    setLoading(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // -- Invite modal logic --

  const existingEmails = useMemo(() => {
    const set = new Set();
    for (const u of users) set.add(u.email.toLowerCase());
    for (const inv of pendingInvites) {
      if (inv.email) set.add(inv.email.toLowerCase()); // Skip link invites (email is null)
    }
    return set;
  }, [users, pendingInvites]);

  function addEmailsToQueue(raw) {
    const parts = raw.split(/[,\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const toAdd = [];
    let skipped = 0;

    setEmailQueue(prev => {
      const existing = new Set(prev);
      const next = [...prev];
      for (const email of parts) {
        if (!emailRegex.test(email) || existing.has(email) || existingEmails.has(email)) {
          continue;
        }
        existing.add(email);
        next.push(email);
        toAdd.push(email);
      }
      return next;
    });

    skipped = parts.length - toAdd.length;
    return { skipped, total: parts.length };
  }

  function handleAddEmails() {
    if (!inviteInput.trim()) return;
    setInviteNotice(null);
    const parts = inviteInput.split(/[,\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    // Check against current queue + existing users before setState
    const skipped = parts.filter(email =>
      !emailRegex.test(email) || existingEmails.has(email) || emailQueue.includes(email)
    ).length;

    setEmailQueue(prev => {
      const existing = new Set(prev);
      const next = [...prev];
      for (const email of parts) {
        if (!emailRegex.test(email) || existing.has(email) || existingEmails.has(email)) continue;
        existing.add(email);
        next.push(email);
      }
      return next;
    });

    if (skipped > 0) {
      const msg = parts.length === 1
        ? 'This user already exists or has a pending invite.'
        : `${skipped} of ${parts.length} skipped (already exist or have pending invites).`;
      setInviteNotice(msg);
    }
    setInviteInput('');
  }

  function handleCsvFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const emails = parseCsvEmails(ev.target.result);
      addEmailsToQueue(emails.join(','));
      if (csvRef.current) csvRef.current.value = '';
    };
    reader.readAsText(file);
  }

  function removeFromQueue(email) {
    setEmailQueue(prev => prev.filter(e => e !== email));
  }

  async function sendInvites() {
    if (emailQueue.length === 0) return;
    setInviteSending(true);
    try {
      const data = await adminApi('POST', '/v1/admin/invites/bulk', { emails: emailQueue });
      const outcome = describeBulkInvites(data);
      setInviteLinks(outcome.links);
      setMessage({ text: outcome.text, type: data.sent > 0 || data.linkOnly > 0 ? 'success' : 'error' });
      setEmailQueue([]);
      setInviteOpen(false);
      loadData();
    } catch (e) {
      setMessage({ text: e.message, type: 'error' });
    } finally {
      setInviteSending(false);
    }
  }

  function handleInviteClose(open) {
    if (!open) {
      setEmailQueue([]);
      setInviteInput('');
      if (csvRef.current) csvRef.current.value = '';
      setSlackQueue([]);
      setSlackSearch('');
      setSlackSearchResults([]);
      setInviteTab('email');
      setInviteNotice(null);
    }
    setInviteOpen(open);
  }

  // -- Slack invite logic --

  const slackSearchTimeout = useRef(null);

  function handleSlackSearchChange(value) {
    setSlackSearch(value);
    clearTimeout(slackSearchTimeout.current);
    if (!value.trim()) { setSlackSearchResults([]); return; }
    slackSearchTimeout.current = setTimeout(async () => {
      setSlackSearching(true);
      try {
        const results = await adminApi('GET', `/v1/plugins/slack/admin/users?q=${encodeURIComponent(value)}`);
        setSlackSearchResults(Array.isArray(results) ? results : []);
      } catch { setSlackSearchResults([]); }
      setSlackSearching(false);
    }, 300);
  }

  async function loadSlackChannels() {
    try {
      const channels = await adminApi('GET', '/v1/plugins/slack/admin/channels');
      setSlackChannels(Array.isArray(channels) ? channels : []);
    } catch { setSlackChannels([]); }
  }

  async function loadChannelMembers(channelId) {
    if (!channelId) return;
    setSlackSearching(true);
    try {
      const members = await adminApi('GET', `/v1/plugins/slack/admin/channels/${channelId}/members`);
      // Add all members to queue at once
      if (Array.isArray(members)) {
        setSlackQueue(prev => {
          const existingIds = new Set(prev.map(u => u.slackUserId));
          const newMembers = members.filter(m => !existingIds.has(m.slackUserId) && m.email && !existingEmails.has(m.email.toLowerCase()));
          return [...prev, ...newMembers];
        });
      }
    } catch { /* ignore */ }
    setSlackSearching(false);
    setSlackSelectedChannel('');
  }

  function addToSlackQueue(user) {
    setInviteNotice(null);
    setSlackQueue(prev => {
      if (prev.some(u => u.slackUserId === user.slackUserId)) {
        setInviteNotice(`${user.name} is already in the queue.`);
        return prev;
      }
      if (user.email && existingEmails.has(user.email.toLowerCase())) {
        setInviteNotice(`${user.name} already exists or has a pending invite.`);
        return prev;
      }
      return [...prev, user];
    });
    setSlackSearch('');
    setSlackSearchResults([]);
  }

  function removeFromSlackQueue(slackUserId) {
    setSlackQueue(prev => prev.filter(u => u.slackUserId !== slackUserId));
  }

  async function sendSlackInvites() {
    if (slackQueue.length === 0) return;
    setSlackSending(true);
    try {
      const data = await adminApi('POST', '/v1/plugins/slack/admin/invites', { users: slackQueue });
      const parts = [];
      if (data.sent > 0) parts.push(`${data.sent} Slack ${data.sent === 1 ? 'invite' : 'invites'} sent`);
      if (data.skipped > 0) parts.push(`${data.skipped} skipped`);
      setMessage({ text: parts.join('. ') + '.', type: data.sent > 0 ? 'success' : 'error' });
      setSlackQueue([]);
      setInviteOpen(false);
      loadData();
    } catch (e) {
      setMessage({ text: e.message, type: 'error' });
    } finally {
      setSlackSending(false);
    }
  }

  // -- Link invite handlers --

  async function handleGenerateLink() {
    setLinkGenerating(true);
    try {
      const data = await adminApi('POST', '/v1/admin/invites/link');
      setLinkInvite(data);
      setMessage({ text: 'Invite link generated', type: 'success' });
    } catch (e) {
      setMessage({ text: e.message, type: 'error' });
    } finally {
      setLinkGenerating(false);
    }
  }

  function handleRegenerateLink() {
    setConfirmModal({
      title: 'Regenerate Invite Link?',
      message: 'Regenerate the shareable invite link? The old link will immediately stop working.',
      confirmLabel: 'Regenerate Link',
      variant: 'default',
      onConfirm: async () => {
        await handleGenerateLink();
      },
    });
  }

  function handleDeleteLink() {
    setConfirmModal({
      title: 'Delete Invite Link?',
      message: 'Delete the shareable invite link? This cannot be undone.',
      confirmLabel: 'Delete Link',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await adminApi('DELETE', '/v1/admin/invites/link');
          setLinkInvite(null);
          setMessage({ text: 'Invite link deleted', type: 'success' });
        } catch (e) {
          setMessage({ text: e.message, type: 'error' });
        }
      },
    });
  }

  // -- User actions --

  async function resendInvite(email) {
    try {
      const data = await adminApi('POST', '/v1/admin/invites/resend', { email });
      const outcome = describeSingleInvite(email, data);
      setInviteLinks(outcome.links);
      setMessage({ text: outcome.text, type: 'success' });
      loadData();
    } catch (e) { setMessage({ text: e.message, type: 'error' }); }
  }

  async function inviteFromWaitlist(token, email) {
    try {
      const data = await adminApi('POST', `/v1/admin/waitlist/${token}/invite`);
      const outcome = describeSingleInvite(email, data);
      setInviteLinks(outcome.links);
      setMessage({ text: outcome.text, type: 'success' });
      loadData();
      return true;
    } catch (e) { setMessage({ text: e.message, type: 'error' }); return false; }
  }

  function removeFromWaitlist(token, email, onRemoved) {
    setConfirmModal({
      title: 'Remove from Wait List?',
      message: `Remove ${email} from the wait list?`,
      confirmLabel: 'Remove',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await adminApi('DELETE', `/v1/admin/waitlist/${token}`);
          loadData();
          if (onRemoved) onRemoved();
        } catch (e) {
          setMessage({ text: e.message, type: 'error' });
        }
      },
    });
  }

  // -- Edit a wait-list entry (#363) --
  // Driven by the URL (/plato/users/waitlist/:token), like Edit User.
  const editEntry = waitlistToken ? waitlistEntries.find((w) => w.inviteToken === waitlistToken) || null : null;
  useEffect(() => {
    // Stale link (invited/removed since): back to the list once data is in.
    if (waitlistToken && !loading && !editEntry) navigate('/plato/users', { replace: true });
  }, [waitlistToken, loading, editEntry, navigate]);

  // The list and both editors are one route component, so the title follows
  // the view rather than being set once on mount.
  const editUserName = editUser ? (editUser.name || editUser.email) : '';
  useEffect(() => {
    if (editUserName) document.title = `Edit ${editUserName} — plato`;
    else if (editEntry) document.title = 'Edit wait-list entry — plato';
    else document.title = 'Users — plato';
  }, [editUserName, editEntry]);

  function revokeInvite(token, email) {
    setConfirmModal({
      title: 'Revoke Invite?',
      message: `Revoke the pending invite for ${email}? The invite link in their email will stop working.`,
      confirmLabel: 'Revoke Invite',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await adminApi('DELETE', `/v1/admin/invites/${token}`);
          setMessage({ text: `Invite for ${email} revoked.`, type: 'success' });
          loadData();
        } catch (e) {
          setMessage({ text: e.message || 'Failed to revoke invite.', type: 'error' });
        }
      },
    });
  }

  function deleteUser(userId, name, onDeleted) {
    setConfirmModal({
      title: 'Delete User?',
      message: `Delete ${name} and all their data? This cannot be undone.`,
      confirmLabel: 'Delete User',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await adminApi('DELETE', `/v1/admin/users/${userId}`);
          if (onDeleted) onDeleted();
          loadData();
        } catch (e) {
          setMessage({ text: e.message, type: 'error' });
        }
      },
    });
  }

  function resetUserPassword(userId, email) {
    setConfirmModal({
      title: 'Send Password Reset?',
      message: `Send a password reset email to ${email}?`,
      confirmLabel: 'Send Reset Email',
      variant: 'default',
      onConfirm: async () => {
        try {
          const data = await adminApi('POST', `/v1/admin/users/${userId}/reset-password`);
          setMessage({ text: describeAdminReset(email, data), type: 'success' });
        } catch (e) {
          setMessage({ text: e.message, type: 'error' });
        }
      },
    });
  }

  // -- Groups --

  async function addGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      const data = await adminApi('PUT', '/v1/admin/groups', { name });
      setGroups(data.userGroups || []);
      setNewGroupName('');
    } catch (e) { setMessage({ text: e.message, type: 'error' }); }
  }

  // Deleting a group clears it from every member server-side, so it confirms
  // first (like courses and user fields) and names how many users it touches.
  function deleteGroup(name) {
    const members = users.filter((u) => u.userGroup === name).length;
    const scope = members > 0
      ? ` and cleared from ${members} ${members === 1 ? 'user' : 'users'}`
      : '';
    setConfirmModal({
      title: 'Delete group?',
      message: `"${name}" will be removed${scope}. This can't be undone.`,
      confirmLabel: 'Delete group',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          const data = await adminApi('DELETE', `/v1/admin/groups/${encodeURIComponent(name)}`);
          setGroups(data.userGroups || []);
          if (members > 0) loadData();
        } catch (e) { setMessage({ text: e.message, type: 'error' }); }
        // The deleted row's button is gone; keep focus in the groups dialog.
        document.getElementById('new-group-name')?.focus();
      },
    });
  }

  // -- Edit user --
  // editUser is driven by the URL (/plato/users/:userId) so deep-linking and
  // browser refresh / back-button preserve the selection. openEditUser only
  // navigates; the effect below populates state from the URL param + users list.

  const seededUserIdRef = useRef(null);

  function openEditUser(u) {
    navigate(`/plato/users/${u.userId}`);
  }

  function closeEditUser() {
    if (paramUserId) {
      try { sessionStorage.removeItem(`plato_admin_edit_user_draft:${paramUserId}`); } catch { /* ignore */ }
    }
    seededUserIdRef.current = null;
    navigate('/plato/users');
  }

  useEffect(() => {
    if (!paramUserId) {
      seededUserIdRef.current = null;
      setEditUser(null);
      return;
    }
    // Wait until users have loaded; if userId doesn't resolve to a known user,
    // route back to the list (e.g. stale URL pointing at a deleted user).
    if (users.length === 0) return;
    const u = users.find((x) => x.userId === paramUserId);
    if (!u) {
      navigate('/plato/users', { replace: true });
      return;
    }
    setEditUser(u);
    if (seededUserIdRef.current !== paramUserId) {
      seededUserIdRef.current = paramUserId;
      let savedDraft = null;
      try {
        const raw = sessionStorage.getItem(`plato_admin_edit_user_draft:${paramUserId}`);
        if (raw) savedDraft = JSON.parse(raw);
      } catch { /* ignore */ }
      setEditForm(savedDraft || {
        name: u.name || '',
        email: u.email || '',
        username: u.username || '',
        userGroup: u.userGroup || '',
        role: u.role || 'user',
        customFields: { ...(u.customFields || {}) },
      });
    }
  }, [paramUserId, users, navigate]);

  useEffect(() => {
    if (!paramUserId || seededUserIdRef.current !== paramUserId) return;
    try {
      sessionStorage.setItem(`plato_admin_edit_user_draft:${paramUserId}`, JSON.stringify(editForm));
    } catch { /* ignore */ }
  }, [paramUserId, editForm]);

  async function saveEditUser() {
    if (!editUser) return;
    const missing = missingRequired(userFields, editForm.customFields);
    if (missing.length) {
      const labels = userFields.filter(f => missing.includes(f.id)).map(f => f.label);
      setMessage({ text: `Fill in required ${labels.length === 1 ? 'field' : 'fields'}: ${labels.join(', ')}.`, type: 'error' });
      return;
    }
    try {
      await adminApi('PATCH', `/v1/admin/users/${editUser.userId}`, {
        name: editForm.name,
        email: editForm.email,
        username: editForm.username,
        userGroup: editForm.userGroup || null,
        // Send every defined field so cleared inputs clear the stored value.
        customFields: Object.fromEntries(userFields.map((f) => [f.id, editForm.customFields[f.id] ?? ''])),
      });
      if (editForm.role !== editUser.role) {
        await adminApi('PUT', `/v1/admin/users/${editUser.userId}/role`, { role: editForm.role });
      }
      setMessage({ text: 'User updated.', type: 'success' });
      closeEditUser();
      loadData();
    } catch (e) { setMessage({ text: e.message, type: 'error' }); }
  }

  // -- Filtering, search, pagination --

  const combinedList = useMemo(() => {
    // Build unified list: invites first, then users
    // Filter out link invites (shown in the Link tab, not the user list)
    const items = [];
    for (const inv of pendingInvites) {
      if (!inv.isLink) {
        items.push({ _type: 'invite', _key: inv.inviteToken, email: inv.email, name: null, username: null, userGroup: null, role: null, customFields: null, createdAt: inv.createdAt, _invite: inv });
      }
    }
    for (const w of waitlistEntries) {
      items.push({ _type: 'waitlist', _key: w.inviteToken, email: w.email, name: w.name, username: null, userGroup: w.userGroup, role: null, customFields: w.customFields || {}, createdAt: w.createdAt, _entry: w });
    }
    for (const u of users) {
      items.push({ _type: 'user', _key: u.userId, email: u.email, name: u.name, username: u.username, userGroup: u.userGroup, role: u.role, customFields: u.customFields || {}, createdAt: u.createdAt, _user: u });
    }
    return items;
  }, [users, pendingInvites, waitlistEntries]);

  const filterCounts = useMemo(() => ({
    all: combinedList.length,
    active: combinedList.filter(i => i._type === 'user' && i.role === 'user').length,
    admins: combinedList.filter(i => i._type === 'user' && i.role === 'admin').length,
    invited: combinedList.filter(i => i._type === 'invite').length,
    waitlist: combinedList.filter(i => i._type === 'waitlist').length,
  }), [combinedList]);

  const filteredList = useMemo(() => {
    let list = combinedList;

    // Apply filter
    if (filter === 'active') list = list.filter(i => i._type === 'user' && i.role === 'user');
    else if (filter === 'admins') list = list.filter(i => i._type === 'user' && i.role === 'admin');
    else if (filter === 'invited') list = list.filter(i => i._type === 'invite');
    else if (filter === 'waitlist') list = list.filter(i => i._type === 'waitlist');

    // Apply custom-field filter (invites have no field values, so they drop out)
    const filterDef = userFields.find(f => f.id === fieldFilter.fieldId);
    if (filterDef && fieldFilter.value) {
      list = list.filter(i => i._type !== 'invite' && matchesFieldFilter(i.customFields, filterDef, fieldFilter.value));
    }

    // Apply search (custom field values are searchable too)
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(i =>
        (i.email && i.email.toLowerCase().includes(q)) ||
        (i.name && i.name.toLowerCase().includes(q)) ||
        (i.username && i.username.toLowerCase().includes(q)) ||
        customFieldsMatch(i.customFields, q)
      );
    }

    return list;
  }, [combinedList, filter, search, userFields, fieldFilter]);

  const filterField = userFields.find(f => f.id === fieldFilter.fieldId) || null;

  // Sort comparators live at module level (SORT_KEY_FNS) so their references
  // are stable; nullish values always sort last regardless of direction so
  // invites (which lack user-stat fields) cluster predictably rather than
  // ping-ponging between top and bottom on direction flip.
  const sortedList = useMemo(() => {
    const keyFn = SORT_KEY_FNS[sortBy.key] || SORT_KEY_FNS.name;
    const mult = sortBy.dir === 'desc' ? -1 : 1;
    return [...filteredList].sort((a, b) => {
      const va = keyFn(a);
      const vb = keyFn(b);
      const aNull = va == null || va === '';
      const bNull = vb == null || vb === '';
      if (aNull && bNull) return 0;
      if (aNull) return 1;   // nullish always last
      if (bNull) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
      return va.toString().localeCompare(vb.toString(), undefined, { numeric: true, sensitivity: 'base' }) * mult;
    });
  }, [filteredList, sortBy]);

  const totalPages = Math.max(1, Math.ceil(sortedList.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = sortedList.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function handleSort(key) {
    setSortBy((prev) => {
      const next = prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' };
      // Announcement goes via setState so SRs hear it from the live region.
      // We update it from the same click handler (not an effect) so the
      // message is in sync with the visible sort and we don't cascade re-renders.
      const label = SORT_LABELS[next.key] || next.key;
      setSortAnnouncement(`Sorted by ${label}, ${next.dir === 'asc' ? 'ascending' : 'descending'}.`);
      return next;
    });
  }


  // Reset page when filter/search/sort changes
  useEffect(() => { setPage(1); }, [filter, search, sortBy, fieldFilter]);

  if (loading && !loaded) return <div className="flex items-center justify-center py-12 text-muted-foreground" role="status" aria-live="polite">Loading...</div>;

  const confirmModalElement = confirmModal ? (
    <ConfirmModal
      open={!!confirmModal}
      onOpenChange={(nextOpen) => { if (!nextOpen) setConfirmModal(null); }}
      title={confirmModal.title}
      message={confirmModal.message}
      confirmLabel={confirmModal.confirmLabel}
      variant={confirmModal.variant}
      onConfirm={confirmModal.onConfirm}
    />
  ) : null;

  if (editEntry) {
    const back = () => navigate('/plato/users');
    return (
      <>
        <WaitlistEntryEdit
          key={editEntry.inviteToken}
          entry={editEntry}
          groups={groups}
          userFields={userFields}
          onBack={back}
          onSaved={(text) => { setMessage({ text, type: 'success' }); back(); loadData(); }}
          onInvite={async (e) => { if (await inviteFromWaitlist(e.inviteToken, e.email)) back(); }}
          onRemove={(e) => { removeFromWaitlist(e.inviteToken, e.email, back); }}
        />
        {confirmModalElement}
      </>
    );
  }

  // Edit user view
  if (editUser) {
    const isSelf = editUser.userId === currentUser?.userId;
    return (
      <div>
        <div className="flex items-center gap-3 mb-4">
          <Button variant="ghost" size="sm" onClick={closeEditUser} aria-label="Back to users">&larr; Back</Button>
          <h1 className="text-2xl font-bold">Edit User</h1>
        </div>
        {message && (
          <div className={`rounded-lg border px-4 py-3 mb-4 text-sm ${message.type === 'error' ? 'border-danger-border bg-danger text-danger-foreground' : 'border-success-border bg-success text-success-foreground'}`} role="alert">
            {message.text}
          </div>
        )}
        <Card>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" type="text" enterKeyHint="done" value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input id="edit-email" type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-username">Username</Label>
              <Input id="edit-username" type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" value={editForm.username} onChange={e => setEditForm({ ...editForm, username: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-group">User Group</Label>
              <select id="edit-group" value={editForm.userGroup}
                onChange={e => setEditForm({ ...editForm, userGroup: e.target.value })}
                className="h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base md:text-sm">
                <option value="">None</option>
                {groups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            {userFields.map(f => (
              <CustomFieldInput
                key={f.id}
                field={f}
                idPrefix="edit-field"
                value={editForm.customFields[f.id]}
                onChange={(v) => setEditForm(prev => ({ ...prev, customFields: { ...prev.customFields, [f.id]: v } }))}
              />
            ))}
            {!isSelf && (
              <div className="space-y-2">
                <Label htmlFor="edit-role">Role</Label>
                <select id="edit-role" value={editForm.role}
                  onChange={e => setEditForm({ ...editForm, role: e.target.value })}
                  className="h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base md:text-sm">
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button onClick={saveEditUser}>Save</Button>
              <Button variant="outline" onClick={closeEditUser}>Cancel</Button>
              {!isSelf && (
                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto sm:ml-auto">
                  <Button variant="outline" onClick={() => resetUserPassword(editUser.userId, editUser.email)}>
                    Reset Password
                  </Button>
                  <Button variant="destructive" onClick={() => deleteUser(editUser.userId, editUser.name || editUser.email, closeEditUser)}>
                    Delete User
                  </Button>
                </div>
              )}
            </div>
            <PluginSlot name="adminProfileFields" context={{ user: editUser }} />
          </CardContent>
        </Card>
        <div className="mt-4">
          <UserStatsPanel key={editUser.userId} userId={editUser.userId} />
        </div>
        {confirmModalElement}
      </div>
    );
  }

  const filterButtons = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Learners' },
    { key: 'admins', label: 'Admins' },
    { key: 'invited', label: 'Invited' },
    { key: 'waitlist', label: 'Wait List' },
  ];

  return (
    <div>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between mb-5">
        <h1 className="text-2xl font-bold">Users</h1>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setInviteOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Invite Users
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-medium whitespace-nowrap hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
              Manage
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setGroupsOpen(true)}>User Groups</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setFieldsOpen(true)}>User Fields</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setWaitlistOpen(true)}>Wait List Settings</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {message && (
        <div className={`flex items-center justify-between rounded-lg border px-4 py-3 mb-4 text-sm ${
          message.type === 'error' ? 'border-danger-border bg-danger text-danger-foreground' : 'border-success-border bg-success text-success-foreground'
        }`} role="alert">
          <span>{message.text}</span>
          <button type="button" onClick={() => { setMessage(null); setInviteLinks([]); }} aria-label="Dismiss" className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-lg leading-none hover:opacity-70">&times;</button>
        </div>
      )}

      {inviteLinks.length > 0 && (
        <ul className="mb-4 space-y-2" aria-label="Invite links to copy">
          {inviteLinks.map(({ email, signupUrl }) => (
            <li key={signupUrl} className="rounded-lg border border-border px-4 py-3">
              <CopyLinkField
                label={<span className="min-w-0 truncate"><span className="sr-only">Invite link for </span>{email}</span>}
                value={signupUrl}
                copyLabel={`Copy invite link for ${email}`}
              />
            </li>
          ))}
        </ul>
      )}

      {loadError && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger px-4 py-3 mb-4 text-sm text-danger-foreground" role="alert">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={loadData}>Retry</Button>
        </div>
      )}

      {!loadError && (waitlistLoadFailed || linkLoadFailed) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning px-4 py-3 mb-4 text-sm text-warning-foreground" role="alert">
          <span>
            {waitlistLoadFailed && linkLoadFailed
              ? "The wait list and the shareable invite link couldn't be loaded. They stay hidden until they load."
              : waitlistLoadFailed
                ? "The wait list couldn't be loaded. Its entries and settings stay hidden until it loads."
                : "The shareable invite link couldn't be loaded. It stays hidden until it loads."}
          </span>
          <Button variant="outline" size="sm" onClick={loadData}>Retry</Button>
        </div>
      )}

      {/* Search and filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-4">
        <Label htmlFor="users-search" className="sr-only">Search users</Label>
        <Input
          id="users-search"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={userFields.length ? 'Search by email, username, name, or field...' : 'Search by email, username, or name...'}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter users">
          {filterButtons.map(f => (
            <Button
              key={f.key}
              variant={filter === f.key ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
            >
              {f.label} <span className="ml-1 opacity-60 tabular-nums">{filterCounts[f.key]}</span>
            </Button>
          ))}
        </div>
        {userFields.length > 0 && (
          <div className="flex flex-wrap gap-2 min-w-0 max-w-full" role="group" aria-label="Filter by custom field">
            <select
              aria-label="Custom field"
              value={fieldFilter.fieldId}
              onChange={e => setFieldFilter({ fieldId: e.target.value, value: e.target.value ? '__set' : '' })}
              className="h-9 min-w-0 max-w-full truncate rounded-lg border border-input bg-transparent px-3 text-base md:text-sm"
            >
              <option value="">Any field</option>
              {userFields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            {filterField && (
              <select
                aria-label={`${filterField.label} value`}
                value={fieldFilter.value}
                onChange={e => setFieldFilter(prev => ({ ...prev, value: e.target.value }))}
                className="h-9 min-w-0 max-w-full truncate rounded-lg border border-input bg-transparent px-3 text-base md:text-sm"
              >
                <option value="__set">Has a value</option>
                <option value="__empty">Empty</option>
                {filterField.type === 'dropdown' && (filterField.options || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
          </div>
        )}
      </div>

      {/* Polite live region announces sort changes for screen-reader users
          (aria-sort attribute changes aren't reliably announced by NVDA/JAWS). */}
      <div role="status" aria-live="polite" className="sr-only">{sortAnnouncement}</div>

      {filteredList.length > 0 ? (
        <>
          <div className="rounded-lg border overflow-hidden">
            <Table aria-label="Users and invites">
              <TableHeader>
                <TableRow>
                  <SortHeader sortKey="name" sortBy={sortBy} onSort={handleSort}>User</SortHeader>
                  <SortHeader sortKey="group" sortBy={sortBy} onSort={handleSort}>Group</SortHeader>
                  <SortHeader sortKey="role" sortBy={sortBy} onSort={handleSort}>Role</SortHeader>
                  <SortHeader sortKey="completed" sortBy={sortBy} onSort={handleSort} align="center">Completed</SortHeader>
                  <SortHeader sortKey="lastActive" sortBy={sortBy} onSort={handleSort}>Last active</SortHeader>
                  <SortHeader sortKey="date" sortBy={sortBy} onSort={handleSort}>Date added</SortHeader>
                  {filterField && <TableHead>{filterField.label}</TableHead>}
                  {slackConnected && <TableHead>Slack</TableHead>}
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map(item => item._type === 'waitlist' ? (
                  <TableRow key={item._key} className="hover:bg-muted/50">
                    <TableCell className="whitespace-normal">
                      <div className="min-w-0 max-w-56">
                        <button type="button" className="touch-target block max-w-full truncate rounded-sm text-left font-medium underline underline-offset-4 cursor-pointer hover:text-link" aria-label={`Edit wait list entry for ${item.name || item.email}`} onClick={() => navigate(`/plato/users/waitlist/${item._key}`)}>
                          {item.name || item.email}
                        </button>
                        <span className="block truncate text-xs text-muted-foreground">{item.name ? item.email : 'Wait list'}</span>
                      </div>
                    </TableCell>
                    <TableCell>{item.userGroup || <span className="text-muted-foreground">&mdash;</span>}</TableCell>
                    <TableCell><Badge variant="outline">Wait List</Badge></TableCell>
                    <TableCell className="text-muted-foreground text-center">&mdash;</TableCell>
                    <TableCell className="text-muted-foreground">&mdash;</TableCell>
                    <TableCell>{new Date(item.createdAt).toLocaleDateString()}</TableCell>
                    {filterField && (
                      <TableCell className="max-w-48 truncate">
                        {item.customFields[filterField.id] || <span className="text-muted-foreground">&mdash;</span>}
                      </TableCell>
                    )}
                    {slackConnected && <TableCell className="text-muted-foreground">&mdash;</TableCell>}
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="outline" size="xs" aria-label={`Invite ${item.email}`} onClick={() => inviteFromWaitlist(item._key, item.email)}>Invite</Button>
                        <Button variant="ghost" size="icon-xs" title="Remove" aria-label={`Remove ${item.email} from the wait list`} onClick={() => removeFromWaitlist(item._key, item.email)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : item._type === 'invite' ? (
                  <TableRow key={item._key}>
                    <TableCell className="whitespace-normal text-muted-foreground">
                      <div className="min-w-0 max-w-56">
                        <span className="block truncate max-w-full font-medium text-foreground" title={item.email}>{item.email}</span>
                        <span className="block truncate text-xs">Pending invite</span>
                      </div>
                    </TableCell>
                    <TableCell>&mdash;</TableCell>
                    <TableCell><Badge variant="outline">Invited</Badge></TableCell>
                    <TableCell className="text-muted-foreground text-center">&mdash;</TableCell>
                    <TableCell className="text-muted-foreground">&mdash;</TableCell>
                    <TableCell>{new Date(item.createdAt).toLocaleDateString()}</TableCell>
                    {filterField && <TableCell className="text-muted-foreground">&mdash;</TableCell>}
                    {slackConnected && <TableCell className="text-muted-foreground">&mdash;</TableCell>}
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon-xs" title="Resend" aria-label={`Resend invite to ${item.email}`} onClick={() => resendInvite(item.email)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                        </Button>
                        <Button variant="ghost" size="icon-xs" title="Revoke" aria-label={`Revoke invite for ${item.email}`} onClick={() => revokeInvite(item._invite.inviteToken, item.email)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={item._key} className="hover:bg-muted/50">
                    <TableCell className="whitespace-normal">
                      <div className="min-w-0 max-w-56">
                        <button type="button" className="touch-target block max-w-full truncate rounded-sm text-left font-medium underline underline-offset-4 cursor-pointer hover:text-link" aria-label={`Edit ${item.name || item.email}`} onClick={() => openEditUser(item._user)}>
                          {item.name || item.email}
                        </button>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[item.username ? `@${item.username}` : null, item.name ? item.email : null].filter(Boolean).join(' · ') || 'User account'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{item.userGroup || <span className="text-muted-foreground">&mdash;</span>}</TableCell>
                    <TableCell>
                      <Badge variant={item.role === 'admin' ? 'default' : 'secondary'}>
                        {item.role === 'admin' ? 'Admin' : 'User'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      {typeof item._user.lessonsCompleted === 'number' ? (
                        <div className="inline-flex">
                          <CompletionRing
                            completed={item._user.lessonsCompleted}
                            available={item._user.lessonsAvailable}
                            size={40}
                            strokeWidth={5}
                            compact
                          />
                        </div>
                      ) : <span className="text-muted-foreground">&mdash;</span>}
                    </TableCell>
                    <TableCell>
                      {item._user.lastActiveAt
                        ? new Date(item._user.lastActiveAt).toLocaleDateString()
                        : <span className="text-muted-foreground">&mdash;</span>}
                    </TableCell>
                    <TableCell>{new Date(item.createdAt).toLocaleDateString()}</TableCell>
                    {filterField && (
                      <TableCell className="max-w-48 truncate">
                        {item.customFields[filterField.id] || <span className="text-muted-foreground">&mdash;</span>}
                      </TableCell>
                    )}
                    {slackConnected && (
                      <TableCell>
                        {item._user.slackUserId ? (
                          <span title={item._user.slackUserId} className="text-xs">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="inline-block mr-1 text-muted-foreground" aria-label="Slack linked">
                              <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z" fill="currentColor"/>
                            </svg>
                            Linked
                          </span>
                        ) : <span className="text-muted-foreground">&mdash;</span>}
                      </TableCell>
                    )}
                    <TableCell>
                      {/* Keep clicks and Enter/Space on these buttons from also activating the row. */}
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}>
                        <PluginSlot name="adminUserRowAction" context={{ user: item._user }} />
                        {item._user.userId !== currentUser?.userId && (
                          <Button variant="ghost" size="icon-xs" title="Delete" aria-label={`Delete ${item.name || item.email}`} onClick={(e) => { e.stopPropagation(); deleteUser(item._user.userId, item.name || item.email); }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <nav className="flex items-center justify-center gap-3 mt-4" aria-label="Pagination">
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
        </>
      ) : (
        <p className="text-muted-foreground py-8 text-center">
          {loadError ? 'Users could not be loaded. Retry above.' : search || filter !== 'all' ? 'No matching users.' : 'No users yet. Click "Invite Users" to get started.'}
        </p>
      )}

      {/* Invite Users Modal */}
      <Dialog open={inviteOpen} onOpenChange={handleInviteClose}>
        <DialogContent variant="sheet">
          <DialogHeader>
            <DialogTitle>Invite Users</DialogTitle>
            <DialogDescription>
              {slackConnected
                ? 'Invite users via email or Slack DM.'
                : 'Add emails to invite. You can type multiple separated by commas or upload a CSV.'}
            </DialogDescription>
          </DialogHeader>

          {inviteNotice && (
            <p className="text-sm text-warning-foreground" role="status">{inviteNotice}</p>
          )}

          <Tabs defaultValue="email" value={inviteTab} onValueChange={(v) => { setInviteTab(v); setInviteNotice(null); if (v === 'slack' && slackChannels.length === 0) loadSlackChannels(); }}>
            <TabsList className="mb-4" aria-label="Invite method">
              <TabsTrigger value="email" aria-label="Invite via email">Email</TabsTrigger>
              {slackConnected && <TabsTrigger value="slack" aria-label="Invite via Slack">Slack</TabsTrigger>}
              <TabsTrigger value="link" aria-label="Invite via shareable link">Link</TabsTrigger>
            </TabsList>

          {/* Email tab */}
          <TabsContent value="email">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="modal-inv-email">Email(s)</Label>
                <div className="flex gap-2">
                  <Input id="modal-inv-email" type="text" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" placeholder="user@example.com, another@example.com"
                    value={inviteInput} onChange={e => setInviteInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); handleAddEmails(); } }} className="flex-1" />
                  <Button variant="outline" onClick={handleAddEmails}>Add</Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="modal-csv">Or upload CSV</Label>
                <Input id="modal-csv" type="file" accept=".csv,text/csv" ref={csvRef} onChange={handleCsvFile} />
              </div>

              {emailQueue.length > 0 && (
                <div className="space-y-2">
                  <Label>Emails to invite ({emailQueue.length})</Label>
                  <div className="max-h-40 overflow-y-auto overscroll-contain rounded-md border p-2">
                    <div className="flex flex-wrap gap-3">
                      {emailQueue.map(email => (
                        <span key={email} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted pl-2.5 pr-1 py-0.5 text-xs">
                          <span className="truncate">{email}</span>
                          <button
                            type="button"
                            onClick={() => removeFromQueue(email)}
                            className="compose-chip-remove shrink-0 inline-flex items-center justify-center rounded-full hover:text-destructive"
                            aria-label={`Remove ${email}`}
                          >
                            &#10005;
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <DialogFooter>
                <Button onClick={sendInvites} disabled={emailQueue.length === 0 || inviteSending}>
                  {inviteSending ? 'Sending...' : `Send ${emailQueue.length} ${emailQueue.length === 1 ? 'invite' : 'invites'}`}
                </Button>
              </DialogFooter>
            </div>
          </TabsContent>

          {/* Slack tab */}
          <TabsContent value="slack">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="slack-user-search">Search Slack users</Label>
                <Input
                  id="slack-user-search"
                  type="search"
                  inputMode="search"
                  enterKeyHint="search"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Search by name or email..."
                  value={slackSearch}
                  onChange={e => handleSlackSearchChange(e.target.value)}
                />
                {slackSearching && <p className="text-xs text-muted-foreground">Searching...</p>}
                {slackSearchResults.length > 0 && (
                  <div className="max-h-40 overflow-y-auto overscroll-contain rounded-md border">
                    {slackSearchResults.map(u => (
                      <button
                        key={u.slackUserId}
                        type="button"
                        className="touch-target flex items-center gap-2 min-w-0 w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors"
                        onClick={() => addToSlackQueue(u)}
                      >
                        {u.avatar && <img src={u.avatar} alt="" width="24" height="24" className="w-6 h-6 shrink-0 rounded" />}
                        <span className="font-medium truncate">{u.name}</span>
                        {u.email && <span className="text-muted-foreground text-xs ml-auto truncate min-w-0">{u.email}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="slack-channel-select">Or add from a channel</Label>
                <div className="flex gap-2">
                  <select
                    id="slack-channel-select"
                    value={slackSelectedChannel}
                    onChange={e => setSlackSelectedChannel(e.target.value)}
                    className="h-10 min-w-0 flex-1 truncate rounded-lg border border-input bg-transparent px-3 py-2 text-base md:text-sm"
                  >
                    <option value="">Select a channel...</option>
                    {slackChannels.map(ch => (
                      <option key={ch.id} value={ch.id}>#{ch.name} ({ch.memberCount} members)</option>
                    ))}
                  </select>
                  <Button variant="outline" onClick={() => loadChannelMembers(slackSelectedChannel)} disabled={!slackSelectedChannel || slackSearching}>
                    {slackSearching ? 'Loading...' : 'Add All'}
                  </Button>
                </div>
              </div>

              {slackQueue.length > 0 && (
                <div className="space-y-2">
                  <Label>Slack users to invite ({slackQueue.length})</Label>
                  <div className="max-h-40 overflow-y-auto overscroll-contain rounded-md border p-2">
                    <div className="flex flex-wrap gap-3">
                      {slackQueue.map(u => (
                        <span key={u.slackUserId} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted pl-2.5 pr-1 py-0.5 text-xs">
                          <span className="truncate">{u.name}</span>
                          {!u.email && <span className="text-destructive shrink-0" title="No email on Slack profile">&#9888;</span>}
                          <button
                            type="button"
                            onClick={() => removeFromSlackQueue(u.slackUserId)}
                            className="compose-chip-remove shrink-0 inline-flex items-center justify-center rounded-full hover:text-destructive"
                            aria-label={`Remove ${u.name}`}
                          >
                            &#10005;
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <DialogFooter>
                <Button onClick={sendSlackInvites} disabled={slackQueue.length === 0 || slackSending}>
                  {slackSending ? 'Sending...' : `Send ${slackQueue.length} Slack ${slackQueue.length === 1 ? 'invite' : 'invites'}`}
                </Button>
              </DialogFooter>
            </div>
          </TabsContent>

          {/* Link tab */}
          <TabsContent value="link">
            {linkLoadFailed ? (
              <div className="space-y-3">
                <p className="text-sm text-destructive" role="alert">
                  The current invite link couldn&apos;t be loaded, so it can&apos;t be shown or replaced yet.
                </p>
                <Button variant="outline" onClick={loadData}>Try again</Button>
              </div>
            ) : linkInvite ? (
              <div className="space-y-4">
                <div className="rounded-lg border p-4 bg-muted/50">
                  <CopyLinkField
                    key={linkInvite.inviteToken}
                    id="invite-link"
                    label="Shareable Invite Link"
                    value={`${window.location.origin}/signup?token=${linkInvite.inviteToken}`}
                    copyLabel="Copy shareable invite link"
                  />
                </div>

                <div className="text-sm text-muted-foreground space-y-1">
                  <p>Created: {new Date(linkInvite.createdAt).toLocaleDateString()}</p>
                  <p>Used by: {linkInvite.usageCount || 0} {(linkInvite.usageCount || 0) === 1 ? 'person' : 'people'}</p>
                  <p>Expires: {new Date(linkInvite.ttl * 1000).toLocaleDateString()}</p>
                </div>

                <div className="rounded-lg border border-warning-border bg-warning p-3">
                  <p className="text-sm text-warning-foreground">
                    <strong>Security note:</strong> Anyone with this link can create an account.
                    Only share it in trusted channels. Regenerate to revoke the old link.
                  </p>
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={handleDeleteLink}>
                    Delete Link
                  </Button>
                  <Button onClick={handleRegenerateLink} disabled={linkGenerating}>
                    {linkGenerating ? 'Regenerating...' : 'Regenerate Link'}
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  The link expires after 7 days and can be regenerated anytime.
                </p>

                <div className="rounded-lg border border-warning-border bg-warning p-3">
                  <p className="text-sm text-warning-foreground">
                    <strong>Security note:</strong> Anyone with this link can create an account.
                    Only share it in trusted channels.
                  </p>
                </div>

                <DialogFooter>
                  <Button onClick={handleGenerateLink} disabled={linkGenerating}>
                    {linkGenerating ? 'Generating...' : 'Generate Invite Link'}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* User Fields Modal */}
      <UserFieldsDialog
        open={fieldsOpen}
        onOpenChange={setFieldsOpen}
        fields={userFields}
        onChange={(next) => {
          setUserFields(next);
          // Reset a filter pointing at a deleted field.
          if (fieldFilter.fieldId && !next.some(f => f.id === fieldFilter.fieldId)) setFieldFilter({ fieldId: '', value: '' });
          // Values for deleted fields were erased server-side; refresh rows.
          if (next.length < userFields.length) loadData();
        }}
      />

      <WaitlistDialog
        open={waitlistOpen}
        onOpenChange={setWaitlistOpen}
        settings={waitlistSettings}
        onChange={setWaitlistSettings}
        loadFailed={waitlistLoadFailed}
        onRetry={loadData}
      />

      <Dialog open={groupsOpen} onOpenChange={setGroupsOpen}>
        <DialogContent variant="sheet">
          <DialogHeader>
            <DialogTitle>User Groups</DialogTitle>
            <DialogDescription>Groups are available for users to select during signup.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Label htmlFor="new-group-name" className="sr-only">Group name</Label>
              <Input id="new-group-name" type="text" enterKeyHint="done" placeholder="Group name" value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addGroup(); }} className="flex-1" />
              <Button onClick={addGroup}>Add</Button>
            </div>
            {groups.length > 0 ? (
              <ul className="max-h-[45dvh] overflow-y-auto overscroll-contain space-y-1 pr-1">
                {groups.map(g => (
                  <li key={g} className="flex items-center justify-between gap-2 rounded-md px-3 py-2 bg-muted/50">
                    <span className="text-sm flex-1 min-w-0 truncate">{g}</span>
                    <Button variant="ghost" size="icon-xs" title="Delete" aria-label={`Delete group ${g}`} onClick={() => deleteGroup(g)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No user groups yet.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {confirmModalElement}
    </div>
  );
}
