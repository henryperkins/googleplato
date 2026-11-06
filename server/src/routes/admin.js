import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_LOGO_DATA_URL_CHARS, classroomName, classroomNameError, currentLogoHash, legacyLogo, normalizeThemeColor, parseLogo, publicBranding, publicTheme, readLogo, readLogoOriginal } from '../lib/branding.js';
import db from '../lib/db.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { ROLES, normalizeRole, can } from '../lib/permissions.js';
import { registerHierarchyRoutes } from './admin-hierarchy.js';
import { bundledLessonStatus, actOnBundledLesson } from '../lib/bundled-lessons.js';
import { registerNotificationRoutes } from './admin-notifications.js';
import { addGroup, renameGroup, deleteGroup } from '../lib/groups.js';
import { nameFields, readNameInput } from '../lib/names.js';
import { validLessonId } from '../lib/lesson-files.js';
import { validateLessonMarkdown } from '../lib/lesson-markdown.js';
import { sendInviteEmail, sendAccountInviteEmail, readAutomations, sendTemplated } from '../lib/notifications.js';
import { generateInviteToken, generateResetToken, hashToken } from '../lib/crypto.js';
import { sendResetEmail, emailDeliveryEnabled } from '../lib/email.js';
import { validateUsername } from './auth.js';
import { MAX_EXCHANGES, MINS_PER_EXCHANGE } from '../lib/lesson-limits.js';
import { logger } from '../lib/logger.js';
import { fetchCloudWatchLogs } from '../lib/cloudwatch-logs.js';
import { fetchCloudLoggingLogs, logEntryIdentity } from '../lib/cloud-logging.js';
import { pluginRegistry } from '../lib/plugins/registry.js';
// Plugin lifecycle events go through the activation-aware registry.
import { classifyCache, kickoffAsyncRefresh, refreshStaleLessonStats } from '../lib/lesson-stats-cache.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { normalizeStatus, publicLessonIds } from '../lib/lesson-visibility.js';
import aiSettings from './ai-settings.js';
import { repairCoachContinuity } from '../lib/coach-continuity-repair.js';
import {
  readWaitlistConfig, writeWaitlistConfig, generateWaitlistApiKey, validateWaitlistEntry,
} from '../lib/waitlist.js';
import {
  getFieldDefinitions, validateFieldDefinition, mergeFieldValues, visibleFieldValues, validateValue, MAX_FIELDS,
} from '../lib/user-fields.js';

const admin = new Hono();

const lessonConflict = 'This lesson changed in another session. Load the saved lesson before continuing.';

function checkLessonWrite(c, body, current) {
  if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)) {
    return c.json({ error: 'expectedVersion must be a non-negative integer' }, 400);
  }
  if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !body.operationId || body.operationId.length > 128)) {
    return c.json({ error: 'operationId must be a non-empty string of at most 128 characters' }, 400);
  }
  // A retry after a lost response acknowledges the original write.
  if (body.operationId && body.operationId === current?.data?.authoringOperationId) {
    return c.json({ ok: true, version: current.version });
  }
  if (body.expectedVersion !== undefined && body.expectedVersion !== (current?.version || 0)) {
    return c.json({ error: lessonConflict }, 409);
  }
  return null;
}

async function writeLesson(c, lessonId, body, current, data) {
  data.authoringOperationId = body.operationId || null;
  try {
    const saved = await db.putSyncData('_system', `lesson:${lessonId}`, data, current?.version || 0, {
      strictVersion: body.expectedVersion !== undefined,
    });
    return c.json({ lessonId, ok: true, version: saved?.version ?? (current?.version || 0) + 1 });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      // A departed editor and its resumed copy may retry the same request
      // concurrently. A winning identical operation is success, not conflict.
      if (body.operationId) {
        const saved = await db.getSyncData('_system', `lesson:${lessonId}`, { consistentRead: true });
        if (saved?.data?.authoringOperationId === body.operationId) return c.json({ ok: true, version: saved.version });
      }
      return c.json({ error: lessonConflict }, 409);
    }
    throw error;
  }
}

// Dashboard stats count ONLY published (public) lessons — drafts, privates
// (even when shared to a learner), and user-created custom lessons are excluded
// from every KPI (numerator AND denominator). `normalizeStatus` /
// `publicLessonIds` are the single source of that rule (lesson-visibility.js).

admin.use('/v1/admin/*', authenticate, authorize);
admin.route('/', aiSettings);

admin.post('/v1/admin/users/:userId/lessons/:lessonId/continuity-repair', bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
  if (c.req.query('asUserId')) return c.json({ error: 'Repair is unavailable while viewing another user.' }, 403);
  let input;
  try { input = await c.req.json(); }
  catch { return c.json({ error: 'Invalid JSON repair request.' }, 400); }
  try {
    const state = await repairCoachContinuity(c.req.param('userId'), c.req.param('lessonId'), input);
    // The repair is already committed. An audit outage must not report it as a
    // failed repair and invite a retry against the now-stale snapshot.
    try {
      await db.createAuditLog({ action: 'lesson_continuity_repaired', userId: c.req.param('userId'), performedBy: c.get('userId'),
        details: { lessonId: c.req.param('lessonId'), assignmentMessageId: input.assignmentMessageId,
          learnerMessageId: input.learnerMessageId, removedInsightCount: input.misleadingInsights.length } });
      c.header('X-Plato-Audit-Status', 'recorded');
    } catch {
      c.header('X-Plato-Audit-Status', 'failed');
      logger.error('lesson_continuity_audit_failed', { committed: true });
    }
    return c.json(state);
  } catch (error) {
    if (error.status) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// GET /v1/admin/users
// Pass `?include=stats` to enrich each row with `lessonsCompleted`,
// `lessonsAvailable`, and `lastActiveAt`. `lessonsCompleted` counts only
// completed PUBLIC lessons (drafts/privates/custom excluded). The sync-route
// hook keeps a best-effort denormalized counter, but visibility can't be
// derived from it alone (a lesson may go public→private after completion), so
// this endpoint recomputes from sync-data against the current public-lesson
// set and heals the stored counter when it drifts. `lastActiveAt` is read
// from the user record (lazily backfilled if never set).
admin.get('/v1/admin/users', async (c) => {
  const url = new URL(c.req.url);
  const includeStats = (url.searchParams.get('include') || '').split(',').includes('stats');
  const users = await db.listAllUsers();
  const fieldDefs = getFieldDefinitions((await db.getSyncData('_system', 'settings'))?.data);
  const baseRow = (p) => ({
    userId: p.userId,
    email: p.email,
    username: p.username,
    ...nameFields(p),
    userGroup: p.userGroup,
    role: normalizeRole(p.role),
    slackUserId: p.slackUserId || null,
    customFields: visibleFieldValues(fieldDefs, p.customFields),
    createdAt: p.createdAt,
  });
  if (!includeStats) {
    return c.json(users.map(baseRow));
  }
  const systemItems = await db.getAllSyncData('_system');
  const publicIds = publicLessonIds(systemItems);
  const lessonsAvailable = publicIds.size;
  // One bulk `lessonKB:` read for the whole classroom (PR-8), grouped by
  // user — never a per-user read of the large screenshot:*/messages:*
  // payloads. The heal/backfill writes below run with bounded concurrency.
  const kbByUser = new Map();
  for (const item of await db.getSyncDataByPrefixForAllUsers('lessonKB:')) {
    if (!kbByUser.has(item.userId)) kbByUser.set(item.userId, []);
    kbByUser.get(item.userId).push(item);
  }
  const enriched = await mapWithConcurrency(users, 4, async (p) => {
    // Recompute completed public lessons from sync-data. This also heals the
    // denormalized counter: legacy values (pre-#136) and any inflated values
    // (private/draft/custom completions counted before this filter existed)
    // converge to the correct public-only count on the next admin read.
    const kbItems = kbByUser.get(p.userId) || [];
    let counted = 0;
    for (const item of kbItems) {
      if (item.data?.status === 'completed' && publicIds.has(item.dataKey.slice('lessonKB:'.length))) counted++;
    }
    if (counted !== p.lessonsCompleted) {
      await db.setUserActivityField(p.userId, 'lessonsCompleted', counted).catch(() => {});
    }
    // lastActiveAt is normally maintained on login/refresh; only legacy users
    // (never set) need a backfill, and only then do we pay to read messages.
    let lastActiveAt = p.lastActiveAt || null;
    if (lastActiveAt === null) {
      let lastActiveMs = 0;
      const msgItems = await db.getSyncDataByPrefix(p.userId, 'messages:');
      for (const item of msgItems) {
        if (!Array.isArray(item.data)) continue;
        for (const m of item.data) {
          const t = typeof m?.timestamp === 'number' ? m.timestamp
            : typeof m?.timestamp === 'string' ? Date.parse(m.timestamp)
            : NaN;
          if (Number.isFinite(t) && t > lastActiveMs) lastActiveMs = t;
        }
      }
      if (lastActiveMs > 0) {
        lastActiveAt = new Date(lastActiveMs).toISOString();
        await db.setUserActivityField(p.userId, 'lastActiveAt', lastActiveAt).catch(() => {});
      }
    }
    return {
      ...baseRow(p),
      lessonsCompleted: counted,
      lessonsAvailable,
      lastActiveAt,
    };
  });
  return c.json(enriched);
});

// GET /v1/admin/users/:userId
admin.get('/v1/admin/users/:userId', async (c) => {
  const user = await db.getUserById(c.req.param('userId'));
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  const settings = await db.getSyncData('_system', 'settings');
  return c.json({
    userId: user.userId,
    email: user.email,
    username: user.username,
    ...nameFields(user),
    userGroup: user.userGroup,
    role: normalizeRole(user.role),
    customFields: visibleFieldValues(getFieldDefinitions(settings?.data), user.customFields),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
});

// POST /v1/admin/impersonation/start — admin "View as User" entry point.
// Verifies the target exists, brackets the session in audit_log so cross-user
// reads downstream (`?asUserId=` on /v1/sync, /v1/lessons, etc.) are
// accountable, and returns the target's display profile for the banner UI.
// Per-read audit entries would spam the log; bracket entries are sufficient
// at the same granularity as `user_deleted`.
admin.post('/v1/admin/impersonation/start', async (c) => {
  const { targetUserId } = await c.req.json();
  if (!targetUserId) {
    return c.json({ error: 'targetUserId is required' }, 400);
  }
  const target = await db.getUserById(targetUserId);
  if (!target) {
    return c.json({ error: 'Target user not found' }, 404);
  }
  const adminUser = c.get('user');
  await db.createAuditLog({
    action: 'admin_view_as_user_started',
    userId: target.userId,
    email: target.email,
    performedBy: adminUser.userId,
    details: { targetUsername: target.username, targetName: target.name },
  });
  return c.json({
    userId: target.userId,
    email: target.email,
    username: target.username,
    name: target.name,
    role: normalizeRole(target.role),
  });
});

// POST /v1/admin/impersonation/end — closes the audit-log bracket. Best-effort:
// if the admin closes the tab without calling this, the session simply lacks
// an end entry; the start entry is the source of truth for "an admin looked".
admin.post('/v1/admin/impersonation/end', async (c) => {
  const { targetUserId } = await c.req.json().catch(() => ({}));
  const adminUser = c.get('user');
  let target = null;
  if (targetUserId) {
    target = await db.getUserById(targetUserId);
  }
  await db.createAuditLog({
    action: 'admin_view_as_user_ended',
    // Only a real user id goes in the audit trail (the body is client input).
    userId: target?.userId || null,
    email: target?.email || null,
    performedBy: adminUser.userId,
    details: target ? { targetUsername: target.username, targetName: target.name } : null,
  });
  return c.json({ ok: true });
});

// POST /v1/admin/invites — create invite and send email
admin.post('/v1/admin/invites', async (c) => {
  const { email } = await c.req.json();
  if (!email) {
    return c.json({ error: 'Email is required' }, 400);
  }

  const existing = await db.getUserByEmail(email);
  if (existing) {
    return c.json({ error: 'User with this email already exists' }, 409);
  }

  const pendingInvite = await db.getInviteByEmail(email);
  if (pendingInvite) {
    return c.json({ error: 'A pending invite already exists for this email' }, 409);
  }

  const adminUser = c.get('user');
  const inviteToken = generateInviteToken();

  await db.createInvite({
    inviteToken,
    email,
    invitedBy: adminUser.userId,
  });

  const result = await sendInviteEmail(email, inviteToken, adminUser.name);

  return c.json({ inviteToken, email, ...result, emailDelivery: result.delivered === false ? 'off' : 'sent' }, 201);
});

// POST /v1/admin/invites/bulk — invite multiple users from a list of emails
admin.post('/v1/admin/invites/bulk', async (c) => {
  const { emails } = await c.req.json();
  if (!Array.isArray(emails) || emails.length === 0) {
    return c.json({ error: 'emails array is required' }, 400);
  }
  if (emails.length > 200) {
    return c.json({ error: 'Maximum 200 invites per batch' }, 400);
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const adminUser = c.get('user');
  const results = [];

  for (const email of emails) {
    const trimmed = (email || '').trim().toLowerCase();
    if (!trimmed) continue;

    if (!emailRegex.test(trimmed)) {
      results.push({ email: trimmed, status: 'invalid', reason: 'Invalid email format' });
      continue;
    }

    const existing = await db.getUserByEmail(trimmed);
    if (existing) {
      results.push({ email: trimmed, status: 'skipped', reason: 'User already exists' });
      continue;
    }

    const pendingInvite = await db.getInviteByEmail(trimmed);
    if (pendingInvite) {
      results.push({ email: trimmed, status: 'skipped', reason: 'Pending invite already exists' });
      continue;
    }

    try {
      const inviteToken = generateInviteToken();
      await db.createInvite({
        inviteToken,
        email: trimmed,
        invitedBy: adminUser.userId,
      });
      const emailResult = await sendInviteEmail(trimmed, inviteToken, adminUser.name);
      const linkOnly = emailResult.delivered === false;
      results.push({
        email: trimmed,
        status: linkOnly ? 'link_only' : 'sent',
        emailDelivery: linkOnly ? 'off' : 'sent',
        signupUrl: emailResult.signupUrl,
      });
    } catch (err) {
      results.push({ email: trimmed, status: 'error', reason: err.message });
    }
  }

  const sent = results.filter(r => r.status === 'sent').length;
  const linkOnly = results.filter(r => r.status === 'link_only').length;
  const skipped = results.filter(r => r.status !== 'sent' && r.status !== 'link_only').length;
  return c.json({ sent, linkOnly, skipped, total: results.length, results }, 201);
});

// An invite token is a credential: an email invite's token registers that
// address with any password, and the link's token signs anyone up. Only a
// role that may manage invitations sees tokens. Read-only roles (testers get
// every `*.read`) see the rest, with a stable non-secret `id` for each row.
const inviteId = (token) => hashToken(token).slice(0, 16);
const mayManageInvites = (c) => can(c.get('role'), 'invites.write');

// GET /v1/admin/invites
admin.get('/v1/admin/invites', async (c) => {
  const invites = await db.listInvites();
  const withTokens = mayManageInvites(c);
  return c.json(invites.map((inv) => ({
    id: inviteId(inv.inviteToken),
    ...(withTokens ? { inviteToken: inv.inviteToken } : {}),
    email: inv.email,
    status: inv.status,
    isLink: !!inv.isLink,
    existingAccount: !!inv.forUserId,
    createdAt: inv.createdAt,
  })));
});

// POST /v1/admin/invites/resend — resend invite to an email with a pending invite
admin.post('/v1/admin/invites/resend', async (c) => {
  const { email } = await c.req.json();
  if (!email) return c.json({ error: 'Email is required' }, 400);

  const pendingInvite = await db.getInviteByEmail(email.toLowerCase());
  if (!pendingInvite) {
    return c.json({ error: 'No pending invite found for this email' }, 404);
  }

  // Delete old invite and create a fresh one
  await db.deleteInvite(pendingInvite.inviteToken);
  const adminUser = c.get('user');
  const inviteToken = generateInviteToken();
  await db.createInvite({
    inviteToken,
    email: email.toLowerCase(),
    invitedBy: adminUser.userId,
    profile: pendingInvite.profile || null, // keep a wait-list entry's details
    ...(pendingInvite.forUserId ? { forUserId: pendingInvite.forUserId } : {}),
  });

  const result = pendingInvite.forUserId
    ? await sendAccountInviteEmail(email.toLowerCase(), adminUser.name, { firstName: pendingInvite.profile?.firstName })
    : await sendInviteEmail(email.toLowerCase(), inviteToken, adminUser.name, { firstName: pendingInvite.profile?.firstName });
  return c.json({ inviteToken, email: email.toLowerCase(), ...result, emailDelivery: result.delivered === false ? 'off' : 'sent' }, 201);
});

// DELETE /v1/admin/invites/:token
admin.delete('/v1/admin/invites/:token', async (c) => {
  const token = c.req.param('token');
  const invite = await db.getInvite(token);
  if (!invite) {
    return c.json({ error: 'Invite not found' }, 404);
  }
  await db.deleteInvite(token);
  return c.json({ ok: true });
});

// GET /v1/admin/invites/link — get current invite link
admin.get('/v1/admin/invites/link', async (c) => {
  const linkInvite = await db.getInviteLinkToken();
  if (!linkInvite) {
    return c.json(null);
  }
  return c.json({
    id: inviteId(linkInvite.inviteToken),
    ...(mayManageInvites(c) ? { inviteToken: linkInvite.inviteToken } : {}),
    createdAt: linkInvite.createdAt,
    usageCount: linkInvite.usageCount || 0,
    maxUsages: linkInvite.maxUsages || null,
    createdBy: linkInvite.invitedBy,
    ttl: linkInvite.ttl,
  });
});

// POST /v1/admin/invites/link — create or regenerate invite link
admin.post('/v1/admin/invites/link', async (c) => {
  const adminUser = c.get('user');

  // Delete any existing link invite
  const existingLink = await db.getInviteLinkToken();
  if (existingLink) {
    await db.deleteInvite(existingLink.inviteToken);
    await db.createAuditLog({
      action: 'invite_link_regenerated',
      userId: null,
      performedBy: adminUser.userId,
      details: JSON.stringify({ oldToken: existingLink.inviteToken }),
    });
  } else {
    await db.createAuditLog({
      action: 'invite_link_created',
      userId: null,
      performedBy: adminUser.userId,
    });
  }

  // Create new link invite
  const inviteToken = generateInviteToken();
  await db.createInvite({
    inviteToken,
    email: null,
    invitedBy: adminUser.userId,
    isLink: true,
    usageCount: 0,
    maxUsages: null,
  });

  const newLink = await db.getInvite(inviteToken);
  return c.json({
    inviteToken: newLink.inviteToken,
    createdAt: newLink.createdAt,
    usageCount: 0,
    maxUsages: null,
    ttl: newLink.ttl,
  }, 201);
});

// DELETE /v1/admin/invites/link — delete current invite link
admin.delete('/v1/admin/invites/link', async (c) => {
  const adminUser = c.get('user');
  const linkInvite = await db.getInviteLinkToken();
  if (!linkInvite) {
    return c.json({ error: 'No invite link found' }, 404);
  }
  await db.deleteInvite(linkInvite.inviteToken);
  await db.createAuditLog({
    action: 'invite_link_deleted',
    userId: null,
    performedBy: adminUser.userId,
    details: JSON.stringify({ token: linkInvite.inviteToken }),
  });
  return c.json({ ok: true });
});

// ── Wait list (#363) ──
// Entries are invites rows with status 'waitlist'; see lib/waitlist.js.

// GET /v1/admin/waitlist — entries, plus whether the form is open and a key exists
admin.get('/v1/admin/waitlist', async (c) => {
  const [invites, { config }, settings] = await Promise.all([
    db.listInvites(), readWaitlistConfig(), db.getSyncData('_system', 'settings'),
  ]);
  const fieldDefs = getFieldDefinitions(settings?.data);
  // Someone can join the wait list after they already have an account or an
  // invite; say so, worked out now so it stays true if that changes.
  const accounts = new Set((await db.listAllUsers()).map((u) => (u.email || '').toLowerCase()));
  const invited = new Set(invites.filter((inv) => inv.status === 'pending' && inv.email).map((inv) => inv.email.toLowerCase()));
  const entries = invites
    .filter((inv) => inv.status === 'waitlist')
    .map((inv) => ({
      inviteToken: inv.inviteToken,
      email: inv.email,
      alreadyRegistered: accounts.has(inv.email.toLowerCase()) ? 'account' : invited.has(inv.email.toLowerCase()) ? 'invite' : null,
      ...nameFields(inv.profile),
      userGroup: inv.profile?.userGroup || null,
      customFields: visibleFieldValues(fieldDefs, inv.profile?.customFields),
      createdAt: inv.createdAt,
    }));
  return c.json({ entries, open: !!config.open, hasApiKey: !!config.apiKeyHash });
});

// PUT /v1/admin/waitlist/settings — body `{ open: boolean }`
admin.put('/v1/admin/waitlist/settings', async (c) => {
  const { open } = await c.req.json();
  if (typeof open !== 'boolean') return c.json({ error: 'open must be true or false' }, 400);
  const { item, config } = await readWaitlistConfig();
  await writeWaitlistConfig(item, { ...config, open });
  return c.json({ open });
});

// POST /v1/admin/waitlist/key — make a new API key; replaces any old one.
// The key is shown once; only its hash is stored.
admin.post('/v1/admin/waitlist/key', async (c) => {
  const apiKey = generateWaitlistApiKey();
  const { item, config } = await readWaitlistConfig();
  await writeWaitlistConfig(item, { ...config, apiKeyHash: hashToken(apiKey) });
  await db.createAuditLog({ action: 'waitlist_key_created', userId: null, performedBy: c.get('user').userId });
  return c.json({ apiKey }, 201);
});

// DELETE /v1/admin/waitlist/key — revoke the API key
admin.delete('/v1/admin/waitlist/key', async (c) => {
  const { item, config } = await readWaitlistConfig();
  await writeWaitlistConfig(item, { ...config, apiKeyHash: null });
  await db.createAuditLog({ action: 'waitlist_key_revoked', userId: null, performedBy: c.get('user').userId });
  return c.json({ ok: true });
});

// POST /v1/admin/waitlist/:token/invite — send the invite email. The new invite
// carries the entry's name, group and fields so signup can fill them in.
admin.post('/v1/admin/waitlist/:token/invite', async (c) => {
  const entry = await db.getInvite(c.req.param('token'));
  if (!entry || entry.status !== 'waitlist') return c.json({ error: 'Wait-list entry not found' }, 404);

  if (await db.getInviteByEmail(entry.email)) {
    return c.json({ error: 'A pending invite already exists for this email' }, 409);
  }
  const account = await db.getUserByEmail(entry.email);

  const adminUser = c.get('user');
  const inviteToken = generateInviteToken();
  await db.createInvite({
    inviteToken, email: entry.email, invitedBy: adminUser.userId, profile: entry.profile || null,
    ...(account ? { forUserId: account.userId } : {}),
  });
  await db.deleteInvite(entry.inviteToken);

  const result = account
    ? await sendAccountInviteEmail(entry.email, adminUser.name, { firstName: nameFields(account).firstName })
    : await sendInviteEmail(entry.email, inviteToken, adminUser.name, { firstName: entry.profile?.firstName });
  return c.json({ inviteToken, email: entry.email, existingAccount: !!account, emailDelivery: result.delivered === false ? 'off' : 'sent', ...result }, 201);
});

// POST /v1/admin/waitlist/:token/apply — the entry's email already has an
// account: copy the entry's answers onto it, then remove the entry. Only
// fills what the account is missing (no group yet, blank fields), so nothing
// the person or an admin already set is overwritten. The name is never copied.
admin.post('/v1/admin/waitlist/:token/apply', async (c) => {
  const entry = await db.getInvite(c.req.param('token'));
  if (!entry || entry.status !== 'waitlist') return c.json({ error: 'Wait-list entry not found' }, 404);
  const user = await db.getUserByEmail(entry.email);
  if (!user) return c.json({ error: 'No account has this email' }, 404);

  const settings = (await db.getSyncData('_system', 'settings'))?.data || {};
  const profile = entry.profile || {};
  const updates = {};
  const group = profile.userGroup;
  if (group && !user.userGroup && (settings.userGroups || []).includes(group)) updates.userGroup = group;
  const fields = [];
  const current = user.customFields || {};
  for (const def of getFieldDefinitions(settings)) {
    const value = typeof profile.customFields?.[def.id] === 'string' ? profile.customFields[def.id].trim() : '';
    if (!value || current[def.id] || validateValue(def, value)) continue;
    fields.push(def.id);
    (updates.customFields ||= { ...current })[def.id] = value;
  }

  if (Object.keys(updates).length) await db.updateUser(user.userId, updates);
  await db.deleteInvite(entry.inviteToken);
  await db.createAuditLog({
    action: 'waitlist_applied', userId: user.userId, performedBy: c.get('user').userId,
    details: { userGroup: updates.userGroup || null, fields },
  });
  return c.json({ userId: user.userId, userGroup: updates.userGroup || null, fields });
});

// PUT /v1/admin/waitlist/:token — edit an entry's name, email, group, and
// custom fields. Same validation as joining (required fields included). A new
// email must not already belong to a user, a pending invite, or another entry.
admin.put('/v1/admin/waitlist/:token', async (c) => {
  const entry = await db.getInvite(c.req.param('token'));
  if (!entry || entry.status !== 'waitlist') return c.json({ error: 'Wait-list entry not found' }, 404);
  const body = await c.req.json();
  const settings = await db.getSyncData('_system', 'settings');
  const result = validateWaitlistEntry(body, settings?.data || {});
  if (result.error) return c.json({ error: result.error }, 400);

  if (result.email !== entry.email) {
    if (await db.getUserByEmail(result.email)) return c.json({ error: 'A user with this email already exists' }, 409);
    if (await db.getInviteByEmail(result.email)) return c.json({ error: 'A pending invite already exists for this email' }, 409);
    const other = await db.getWaitlistEntryByEmail(result.email);
    if (other && other.inviteToken !== entry.inviteToken) return c.json({ error: 'This email is already on the wait list' }, 409);
  }

  try {
    await db.updateWaitlistEntry(entry.inviteToken, { email: result.email, profile: result.profile });
  } catch (err) {
    // Invited or removed between the read above and this write.
    if (err.name === 'ConditionalCheckFailedException') return c.json({ error: 'Wait-list entry not found' }, 404);
    throw err;
  }
  return c.json({
    inviteToken: entry.inviteToken,
    email: result.email,
    ...nameFields(result.profile),
    userGroup: result.profile.userGroup,
    customFields: visibleFieldValues(getFieldDefinitions(settings?.data), result.profile.customFields),
    createdAt: entry.createdAt,
  });
});

// DELETE /v1/admin/waitlist/:token — remove an entry
admin.delete('/v1/admin/waitlist/:token', async (c) => {
  const entry = await db.getInvite(c.req.param('token'));
  if (!entry || entry.status !== 'waitlist') return c.json({ error: 'Wait-list entry not found' }, 404);
  await db.deleteInvite(entry.inviteToken);
  // The "Removed from the wait list" automation: once, since the entry is
  // gone now (a second DELETE is a 404). Never fails the removal.
  try {
    if ((await readAutomations()).waitlistRemoved) {
      await sendTemplated('waitlist-removed', { to: entry.email, vars: { firstName: nameFields(entry.profile || {}).firstName } });
    }
  } catch (err) {
    logger.error('waitlist_removed_email_failed', { error: err?.message || String(err) });
  }
  return c.json({ ok: true });
});

// PATCH /v1/admin/users/:userId — update user fields
admin.patch('/v1/admin/users/:userId', async (c) => {
  const userId = c.req.param('userId');
  const user = await db.getUserById(userId);
  if (!user) return c.json({ error: 'User not found' }, 404);
  const body = await c.req.json();
  const updates = {};
  const nameInput = readNameInput(body, { current: user });
  if (nameInput.error) return c.json({ error: nameInput.error }, 400);
  if (nameInput.fields) Object.assign(updates, nameInput.fields);
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'A valid email is required' }, 400);
    // Same rule as PATCH /v1/me: two accounts sharing an email would make
    // login (getUserByEmail) ambiguous.
    const existing = await db.getUserByEmail(email);
    if (existing && existing.userId !== userId) return c.json({ error: 'Email already in use' }, 409);
    updates.email = email;
  }
  if (body.username !== undefined) {
    const usernameErr = validateUsername(body.username);
    if (usernameErr) return c.json({ error: usernameErr }, 400);
    const existing = await db.getUserByUsername(body.username);
    if (existing && existing.userId !== userId) {
      return c.json({ error: 'Username already taken' }, 409);
    }
    updates.username = body.username.toLowerCase();
  }
  if (body.userGroup !== undefined) updates.userGroup = body.userGroup;
  if (body.customFields !== undefined) {
    // Same rule as learner self-edits: the result must have every required
    // field filled. (Users who simply haven't been edited yet are prompted by
    // ProfileCompletionGate on their next classroom visit.)
    const settings = await db.getSyncData('_system', 'settings');
    const merged = mergeFieldValues(getFieldDefinitions(settings?.data), user.customFields, body.customFields, { enforceRequired: true });
    if (merged.error) return c.json({ error: merged.error }, 400);
    updates.customFields = merged.values;
  }
  if (Object.keys(updates).length === 0) return c.json({ error: 'No valid fields' }, 400);
  await db.updateUser(userId, updates);
  return c.json({ ok: true });
});

// PUT /v1/admin/users/:userId/role
admin.put('/v1/admin/users/:userId/role', async (c) => {
  const userId = c.req.param('userId');
  const adminUser = c.get('user');
  if (userId === adminUser.userId) {
    return c.json({ error: 'Cannot change your own role' }, 400);
  }
  const user = await db.getUserById(userId);
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  const body = await c.req.json();
  // Accept the legacy name for learner from older clients.
  const role = body.role === 'user' ? 'learner' : body.role;
  if (!ROLES.includes(role)) {
    return c.json({ error: `Role must be one of: ${ROLES.join(', ')}` }, 400);
  }
  const from = normalizeRole(user.role);
  if (from === role) return c.json({ ok: true, role });
  const countAdmins = async () => (await db.listAllUsers()).filter((u) => normalizeRole(u.role) === 'admin').length;
  // Never leave the classroom without an admin.
  if (from === 'admin' && (await countAdmins()) <= 1) {
    return c.json({ error: 'Cannot change the role of the only admin' }, 400);
  }
  // Conditional on the role we read, so a concurrent change to this user
  // isn't overwritten.
  if (!(await db.setUserRoleIf(userId, user.role, role))) {
    return c.json({ error: 'This user’s role just changed. Reload and try again.' }, 409);
  }
  // The check above is read-then-write: two admins demoting each other at
  // the same moment could both pass it. Re-count after writing, and if no
  // admin is left, undo this change. For any interleaving, at least one
  // admin remains.
  if (from === 'admin' && (await countAdmins()) === 0) {
    await db.setUserRoleIf(userId, role, user.role);
    return c.json({ error: 'Cannot remove the last admin' }, 409);
  }
  await db.createAuditLog({
    action: 'role_changed',
    userId,
    email: user.email,
    performedBy: adminUser.userId,
    details: { from, to: role },
  });
  return c.json({ ok: true, role });
});

// POST /v1/admin/users/:userId/reset-password
// Admin initiates password reset for a user by sending them a reset email.
admin.post('/v1/admin/users/:userId/reset-password', async (c) => {
  const userId = c.req.param('userId');
  const user = await db.getUserById(userId);
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  // D-2(a): with email off, admins do not receive reset links — a reset link
  // is an account-takeover credential. Create no token and say so plainly.
  if (!emailDeliveryEnabled()) {
    return c.json({ ok: true, emailDelivery: 'off' });
  }
  const token = generateResetToken();
  await db.storeResetToken(hashToken(token), user.userId);
  await sendResetEmail(user.email, token);
  return c.json({ ok: true, emailDelivery: 'sent' });
});

// GET /v1/admin/settings
admin.get('/v1/admin/settings', async (c) => {
  const item = await db.getSyncData('_system', 'settings');
  return c.json(item?.data || {});
});

// PUT /v1/admin/settings
admin.put('/v1/admin/settings', async (c) => {
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'A JSON object is required.' }, 400);
  // Branding has its own validated route; a raw merge would bypass it.
  if (['theme', 'classroomName', 'logoAlt', 'logoBase64', 'logoHash'].some(key => Object.hasOwn(body, key))) {
    return c.json({ error: 'Change the classroom name, colors and logo with PUT /v1/admin/theme.' }, 400);
  }
  const current = await db.getSyncData('_system', 'settings');
  const merged = { ...(current?.data || {}), ...body };
  await db.putSyncData('_system', 'settings', merged, current?.version || 0);
  return c.json(merged);
});

// PUT /v1/admin/groups — add or rename an group
admin.put('/v1/admin/groups', async (c) => {
  const { name, oldName } = await c.req.json().catch(() => ({}));
  const user = c.get('user');
  const result = oldName ? await renameGroup(oldName, name) : await addGroup(name);
  if (result.error) return c.json({ error: result.error }, result.status);
  if (oldName && oldName !== name.trim()) {
    try {
      await db.createAuditLog({ action: 'group_renamed', userId: user.userId, performedBy: user.userId, details: { from: oldName, to: name.trim(), ...result.moved } });
    } catch { /* best-effort */ }
  }
  return c.json(result);
});

// DELETE /v1/admin/groups/:name — remove a group; its members, invites, and
// wait-list entries lose it.
admin.delete('/v1/admin/groups/:name', async (c) => {
  const result = await deleteGroup(decodeURIComponent(c.req.param('name')));
  if (result.error) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

// ── Custom user fields (#364) ──
// Definitions are an ordered array in `_system:settings.userFields`; values
// live on each user record's `customFields`. Validation lives in
// lib/user-fields.js. Responses use `{ userFields: [...] }` (mirrors
// `{ userGroups }`).

async function readUserFieldSettings() {
  const current = await db.getSyncData('_system', 'settings');
  const settings = current?.data || {};
  return { current, settings, fields: getFieldDefinitions(settings) };
}

async function writeUserFields(current, settings, fields) {
  settings.userFields = fields;
  await db.putSyncData('_system', 'settings', settings, current?.version || 0);
}

// GET /v1/admin/user-fields
admin.get('/v1/admin/user-fields', async (c) => {
  const { fields } = await readUserFieldSettings();
  return c.json({ userFields: fields });
});

// POST /v1/admin/user-fields — add a field (appended to the end)
admin.post('/v1/admin/user-fields', async (c) => {
  const body = await c.req.json();
  const { current, settings, fields } = await readUserFieldSettings();
  if (fields.length >= MAX_FIELDS) return c.json({ error: `At most ${MAX_FIELDS} custom fields` }, 400);
  const { field, error } = validateFieldDefinition(body);
  if (error) return c.json({ error }, 400);
  if (fields.some((f) => f.label.toLowerCase() === field.label.toLowerCase())) {
    return c.json({ error: 'A field with that label already exists' }, 409);
  }
  fields.push(field);
  await writeUserFields(current, settings, fields);
  return c.json({ userFields: fields }, 201);
});

// PUT /v1/admin/user-fields/order — reorder; body `{ ids: [...] }` must be a
// permutation of the existing ids.
admin.put('/v1/admin/user-fields/order', async (c) => {
  const { ids } = await c.req.json();
  const { current, settings, fields } = await readUserFieldSettings();
  if (!Array.isArray(ids) || ids.length !== fields.length || new Set(ids).size !== ids.length
    || !ids.every((id) => fields.some((f) => f.id === id))) {
    return c.json({ error: 'ids must list every field exactly once' }, 400);
  }
  const reordered = ids.map((id) => fields.find((f) => f.id === id));
  await writeUserFields(current, settings, reordered);
  return c.json({ userFields: reordered });
});

// Every stored answer to field `id`: on user records, and on the profiles of
// wait-list entries and the invites made from them (#363).
async function storedFieldValues(id) {
  const [users, invites] = await Promise.all([db.listAllUsers(), db.listInvites()]);
  return [
    ...users.map((u) => u.customFields?.[id]),
    ...invites.map((inv) => inv.profile?.customFields?.[id]),
  ].filter((v) => typeof v === 'string' && v.trim());
}

// PUT /v1/admin/user-fields/:id — edit a field: label, required, dropdown
// options, and type. Changing the type (or a dropdown's options) can leave
// stored answers that no longer pass validation; if so, reply 409 with
// `invalidCount` unless the body has `confirmInvalid: true`. Confirmed,
// those answers are kept as-is — every later save through any route
// re-validates, so they must be fixed the next time they're edited.
admin.put('/v1/admin/user-fields/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { current, settings, fields } = await readUserFieldSettings();
  const idx = fields.findIndex((f) => f.id === id);
  if (idx === -1) return c.json({ error: 'Field not found' }, 404);
  const { field, error } = validateFieldDefinition({ ...body, type: body.type ?? fields[idx].type }, fields[idx]);
  if (error) return c.json({ error }, 400);
  if (fields.some((f, i) => i !== idx && f.label.toLowerCase() === field.label.toLowerCase())) {
    return c.json({ error: 'A field with that label already exists' }, 409);
  }
  const prev = fields[idx];
  const rulesChanged = field.type !== prev.type
    || (field.type === 'dropdown' && JSON.stringify(field.options) !== JSON.stringify(prev.options));
  if (rulesChanged && body.confirmInvalid !== true) {
    const invalidCount = (await storedFieldValues(id)).filter((v) => validateValue(field, v.trim())).length;
    if (invalidCount > 0) {
      return c.json({
        error: `${invalidCount} existing ${invalidCount === 1 ? 'answer doesn\'t' : 'answers don\'t'} fit the new rules for ${field.label}`,
        invalidCount,
      }, 409);
    }
  }
  fields[idx] = field;
  await writeUserFields(current, settings, fields);
  return c.json({ userFields: fields });
});

// DELETE /v1/admin/user-fields/:id — remove a field and erase its values
// from every user (same cascade as deleting a user group).
admin.delete('/v1/admin/user-fields/:id', async (c) => {
  const id = c.req.param('id');
  const { current, settings, fields } = await readUserFieldSettings();
  const idx = fields.findIndex((f) => f.id === id);
  if (idx === -1) return c.json({ error: 'Field not found' }, 404);
  fields.splice(idx, 1);
  await writeUserFields(current, settings, fields);

  const users = await db.listAllUsers();
  await Promise.all(
    users.filter((u) => u.customFields && Object.hasOwn(u.customFields, id))
      .map((u) => db.removeUserCustomField(u.userId, id))
  );
  // Wait-list entries and the invites made from them (#363) carry answers too.
  const invites = await db.listInvites();
  await Promise.all(
    invites.filter((inv) => inv.profile?.customFields && Object.hasOwn(inv.profile.customFields, id))
      .map((inv) => {
        const { [id]: _removed, ...rest } = inv.profile.customFields;
        return db.setInviteProfile(inv.inviteToken, { ...inv.profile, customFields: rest });
      })
  );

  return c.json({ userFields: fields });
});

// DELETE /v1/admin/users/:userId
admin.delete('/v1/admin/users/:userId', async (c) => {
  const userId = c.req.param('userId');
  const adminUser = c.get('user');
  if (userId === adminUser.userId) {
    return c.json({ error: 'Cannot delete yourself' }, 400);
  }
  const user = await db.getUserById(userId);
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  // Log deletion before destroying data
  await db.createAuditLog({
    action: 'user_deleted',
    userId,
    email: user.email,
    performedBy: adminUser.userId,
    details: { name: user.name, userGroup: user.userGroup, role: user.role, selfDelete: false },
  });

  // Emit userDeleted BEFORE the cascade — plugins can react with the user's data
  // still in place. Hook errors are caught by emit() and don't block deletion.
  await pluginRegistry.emit('userDeleted', { userId, email: user.email, role: normalizeRole(user.role) });

  // Delete all sync data for this user (cascades plugin userMeta:* records
  // too) with one bulk delete — never a full read plus one delete per row.
  await db.deleteAllSyncData(userId);
  await db.revokeUserTokens(userId);
  await db.deleteUser(userId);
  return c.json({ ok: true });
});

// ── Content management (prompts, lessons, knowledge base, theme) ──

// GET /v1/admin/prompts — list all prompts
admin.get('/v1/admin/prompts', async (c) => {
  const items = await db.getAllSyncData('_system');
  const prompts = items
    .filter(i => i.dataKey.startsWith('prompt:'))
    .map(i => ({
      name: i.dataKey.slice('prompt:'.length),
      updatedAt: i.updatedAt,
      updatedBy: i.data.updatedBy || null,
    }));
  return c.json(prompts);
});

// GET /v1/admin/prompts/:name
admin.get('/v1/admin/prompts/:name', async (c) => {
  const name = c.req.param('name');
  const item = await db.getSyncData('_system', `prompt:${name}`);
  if (!item) return c.json({ error: 'Prompt not found' }, 404);
  return c.json({ name, content: item.data.content, updatedAt: item.updatedAt });
});

// PUT /v1/admin/prompts/:name
admin.put('/v1/admin/prompts/:name', async (c) => {
  const name = c.req.param('name');
  const { content } = await c.req.json();
  if (content === undefined) return c.json({ error: 'content is required' }, 400);
  const adminUser = c.get('user');
  const current = await db.getSyncData('_system', `prompt:${name}`);
  await db.putSyncData('_system', `prompt:${name}`, {
    content,
    updatedBy: adminUser.userId,
  }, current?.version || 0);
  return c.json({ name, ok: true });
});

// GET /v1/admin/lessons — list all lessons
admin.get('/v1/admin/lessons', async (c) => {
  const items = await db.getAllSyncData('_system');
  const lessons = items
    .filter(i => i.dataKey.startsWith('lesson:'))
    .map(i => ({
      lessonId: i.dataKey.slice('lesson:'.length),
      name: i.data.name || i.dataKey.slice('lesson:'.length),
      isBuiltIn: i.data.isBuiltIn || false,
      status: normalizeStatus(i.data.status, !!i.data.markdown),
      sharedWith: i.data.sharedWith || [],
      course: i.data.course || null,
      createdByName: i.data.createdByName || null,
      updatedByName: i.data.updatedByName || null,
      updatedAt: i.updatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return c.json(lessons);
});

// GET /v1/admin/lessons/:lessonId
admin.get('/v1/admin/lessons/:lessonId', async (c) => {
  const lessonId = c.req.param('lessonId');
  const item = await db.getSyncData('_system', `lesson:${lessonId}`, { consistentRead: true });
  if (!item) return c.json({ error: 'Lesson not found' }, 404);
  return c.json({ lessonId, ...item.data, version: item.version, updatedAt: item.updatedAt });
});

// PUT /v1/admin/lessons/:lessonId
admin.put('/v1/admin/lessons/:lessonId', async (c) => {
  const lessonId = c.req.param('lessonId');
  if (!validLessonId(lessonId)) return c.json({ error: 'Invalid lesson identifier' }, 400);
  const body = await c.req.json();
  const adminUser = c.get('user');
  const current = await db.getSyncData('_system', `lesson:${lessonId}`, { consistentRead: true });
  // Validate the independent share list before acknowledging a retried write.
  const sharedWith = body.sharedWith !== undefined ? body.sharedWith : (current?.data?.sharedWith || []);
  if (!Array.isArray(sharedWith) || !sharedWith.every(id => typeof id === 'string')) {
    return c.json({ error: 'sharedWith must be an array of user ID strings' }, 400);
  }
  const rejected = checkLessonWrite(c, body, current);
  if (rejected) return rejected;
  // Also protect against delayed autosaves from clients without revision metadata.
  if (body.status === 'draft' && current?.data?.markdown) {
    return c.json({ error: lessonConflict }, 409);
  }
  const markdownToValidate = body.markdown || current?.data?.markdown;
  const hasMarkdown = !!markdownToValidate;
  const currentStatus = normalizeStatus(current?.data?.status, !!current?.data?.markdown);
  const newStatus = normalizeStatus(body.status || currentStatus, hasMarkdown);
  // Drafts are allowed without markdown (they hold a mid-creation conversation).
  // Any non-draft lesson must have markdown.
  if (newStatus !== 'draft' && !hasMarkdown) {
    return c.json({ error: 'markdown is required' }, 400);
  }
  const isGoingPublic = newStatus === 'public' && currentStatus !== 'public';
  const isLeavingDraft = currentStatus === 'draft' && newStatus !== 'draft';
  const markdownChanged = body.markdown && body.markdown !== current?.data?.markdown;
  if ((markdownChanged || isGoingPublic || isLeavingDraft) && hasMarkdown) {
    const mdError = validateLessonMarkdown(markdownToValidate);
    if (mdError) return c.json({ error: mdError }, 400);
  }
  // course is an optional string courseId or null. Don't validate that the
  // courseId points to an existing course — DELETE on a course cascades to
  // clear it from lessons, but we tolerate transient drift.
  let course = body.course !== undefined ? body.course : (current?.data?.course ?? null);
  if (course !== null && course !== undefined && typeof course !== 'string') {
    return c.json({ error: 'course must be a string courseId or null' }, 400);
  }
  if (course === '') course = null;
  const data = {
    markdown: markdownToValidate || '',
    name: body.name || current?.data?.name || lessonId,
    isBuiltIn: body.isBuiltIn !== undefined ? body.isBuiltIn : (current?.data?.isBuiltIn || false),
    status: newStatus,
    sharedWith,
    course,
    conversation: body.conversation !== undefined ? body.conversation : (current?.data?.conversation || null),
    conversationRevision: body.conversationRevision ?? current?.data?.conversationRevision ?? null,
    markdownRevision: body.markdown ? (body.markdownRevision ?? null) : (current?.data?.markdownRevision ?? null),
    readiness: body.readiness !== undefined ? body.readiness : (current?.data?.readiness ?? null),
    updatedBy: adminUser.userId,
    updatedByName: adminUser.username || adminUser.email,
    createdBy: current?.data?.createdBy || adminUser.userId,
    createdByName: current?.data?.createdByName || adminUser.username || adminUser.email,
    createdAt: current?.data?.createdAt || new Date().toISOString(),
    ...(current?.data?.publishedAt ? { publishedAt: current.data.publishedAt } : isGoingPublic ? { publishedAt: new Date().toISOString() } : {}),
    ...(current?.data?.bundled ? { bundled: current.data.bundled } : {}),
  };
  return writeLesson(c, lessonId, body, current, data);
});

// PUT /v1/admin/lessons/:lessonId/conversation — auto-save conversation without requiring markdown
admin.put('/v1/admin/lessons/:lessonId/conversation', async (c) => {
  const lessonId = c.req.param('lessonId');
  const body = await c.req.json();
  const current = await db.getSyncData('_system', `lesson:${lessonId}`, { consistentRead: true });
  if (!current) return c.json({ error: 'Lesson not found' }, 404);
  const rejected = checkLessonWrite(c, body, current);
  if (rejected) return rejected;
  const data = { ...current.data };
  data.conversation = body.conversation || null;
  data.conversationRevision = body.conversationRevision ?? null;
  if (body.readiness !== undefined) data.readiness = body.readiness;
  return writeLesson(c, lessonId, body, current, data);
});

// DELETE /v1/admin/lessons/:lessonId
admin.delete('/v1/admin/lessons/:lessonId', async (c) => {
  const lessonId = c.req.param('lessonId');
  const item = await db.getSyncData('_system', `lesson:${lessonId}`);
  if (!item) return c.json({ error: 'Lesson not found' }, 404);
  await db.deleteSyncData('_system', `lesson:${lessonId}`);
  return c.json({ ok: true });
});

// ── Bundled lessons (#443): Getting Started; see lib/bundled-lessons.js ──
admin.get('/v1/admin/bundled-lessons', async (c) => c.json({ lessons: await bundledLessonStatus() }));

// POST /v1/admin/bundled-lessons/:lessonId — body { action: 'apply' | 'dismiss' | 'dismiss-publish' }
admin.post('/v1/admin/bundled-lessons/:lessonId', async (c) => {
  const lessonId = c.req.param('lessonId');
  const { action } = await c.req.json().catch(() => ({}));
  const user = c.get('user');
  const result = await actOnBundledLesson(lessonId, action, user);
  if (result.error) return c.json({ error: result.error }, result.status);
  if (action === 'apply') {
    try {
      await db.createAuditLog({ action: 'bundled_lesson_updated', userId: user.userId, performedBy: user.userId, details: { lessonId, version: result.version } });
    } catch { /* best-effort */ }
  }
  return c.json(result);
});

// ── Notifications (#388, #389, #400): routes/admin-notifications.js ──
registerNotificationRoutes(admin);

// ── Courses, units, lessons order (#408) ──
// Units are stored as _system:course:<id>, courses as _system:program:<id>.
// Routes and rules live in routes/admin-hierarchy.js and lib/hierarchy.js.
registerHierarchyRoutes(admin);

// GET /v1/admin/knowledge-base
admin.get('/v1/admin/knowledge-base', async (c) => {
  const item = await db.getSyncData('_system', 'knowledgeBase');
  const data = item?.data || {};
  let updatedByName = null;
  if (data.updatedBy && data.updatedBy !== 'setup') {
    const user = await db.getUserById(data.updatedBy);
    updatedByName = user?.name || user?.username || user?.email || null;
  }
  return c.json({
    content: data.content || '',
    conversation: data.conversation || null,
    readiness: data.readiness ?? null,
    updatedAt: item?.updatedAt || null,
    updatedByName,
  });
});

// PUT /v1/admin/knowledge-base
admin.put('/v1/admin/knowledge-base', async (c) => {
  const body = await c.req.json();
  if (body.content === undefined) return c.json({ error: 'content is required' }, 400);
  const current = await db.getSyncData('_system', 'knowledgeBase');
  const adminUser = c.get('user');
  await db.putSyncData('_system', 'knowledgeBase', {
    content: body.content,
    conversation: body.conversation !== undefined ? body.conversation : (current?.data?.conversation || null),
    readiness: body.readiness !== undefined ? body.readiness : (current?.data?.readiness ?? null),
    updatedBy: adminUser.userId,
  }, current?.version || 0);
  return c.json({ ok: true });
});

// PUT /v1/admin/knowledge-base/conversation — auto-save KB editor conversation
admin.put('/v1/admin/knowledge-base/conversation', async (c) => {
  const body = await c.req.json();
  const current = await db.getSyncData('_system', 'knowledgeBase');
  const adminUser = c.get('user');
  await db.putSyncData('_system', 'knowledgeBase', {
    content: current?.data?.content || '',
    conversation: body.conversation || null,
    readiness: body.readiness !== undefined ? body.readiness : (current?.data?.readiness ?? null),
    updatedBy: adminUser.userId,
  }, current?.version || 0);
  return c.json({ ok: true });
});

// GET /v1/admin/theme
admin.get('/v1/admin/theme', async (c) => {
  const item = await db.getSyncData('_system', 'settings', { consistentRead: true });
  const settings = item?.data || {};
  const hash = currentLogoHash(settings);
  const logo = hash ? await readLogo(hash, settings) : null;
  const original = await readLogoOriginal(settings);
  return c.json({
    theme: publicTheme(settings.theme) || {},
    logoBase64: original?.dataUrl || null,
    logoBlocked: Boolean(original?.dataUrl && !logo),
    // Saved by an earlier version, which padded images into squares.
    logoLegacy: Boolean(original?.legacy),
    classroomName: classroomName(settings),
  });
});

export { normalizeThemeColor };

const LOGO_ERROR = 'Logo must be a PNG, JPEG, WebP, or static SVG image encoded as base64, or null to remove it.';

// PUT /v1/admin/theme
// Theme colors reach every learner page header and the auth pages, so they
// are validated here rather than trusted from the customizer form.
admin.put('/v1/admin/theme', bodyLimit({ maxSize: MAX_LOGO_DATA_URL_CHARS + 16 * 1024, onError: c => c.json({ error: 'The logo upload is too large.' }, 413) }), async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'A JSON object is required.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'A JSON object is required.' }, 400);
  const nameError = body.classroomName === undefined ? null : classroomNameError(body.classroomName);
  if (nameError) return c.json({ error: nameError }, 400);
  if (typeof body.logoBase64 === 'string' && body.logoBase64.length > MAX_LOGO_DATA_URL_CHARS) return c.json({ error: 'The encoded logo must be at most 128 KiB.' }, 413);
  if (body.logoBase64 !== undefined && body.logoBase64 !== null && typeof body.logoBase64 !== 'string') return c.json({ error: LOGO_ERROR }, 400);
  if (body.theme !== undefined && body.themePatch !== undefined) return c.json({ error: 'Send either theme or themePatch, not both.' }, 400);
  let theme;
  if (body.theme !== undefined) {
    // A theme without a primary would drop the classroom's brand colors.
    if (!body.theme || typeof body.theme !== 'object' || Array.isArray(body.theme) || body.theme.primary === undefined) {
      return c.json({ error: 'Theme must include a primary color.' }, 400);
    }
    theme = {};
    for (const key of ['primary', 'accent']) {
      if (body.theme[key] === undefined) continue;
      const color = normalizeThemeColor(body.theme[key]);
      if (!color) return c.json({ error: `The ${key} color must be a hex value like #8b1a1a.` }, 400);
      theme[key] = color;
    }
  }
  let themePatch;
  if (body.themePatch !== undefined) {
    if (!body.themePatch || typeof body.themePatch !== 'object' || Array.isArray(body.themePatch)) {
      return c.json({ error: 'Theme patch must be an object.' }, 400);
    }
    themePatch = {};
    for (const [key, value] of Object.entries(body.themePatch)) {
      if (!['primary', 'accent'].includes(key)) return c.json({ error: 'Theme patch may change only primary and accent.' }, 400);
      const color = key === 'accent' && value === null ? null : normalizeThemeColor(value);
      if (color === null && !(key === 'accent' && value === null)) return c.json({ error: `${key} color must be a hex value like #470d99.` }, 400);
      themePatch[key] = color;
    }
  }
  const current = await db.getSyncData('_system', 'settings', { consistentRead: true });
  const settings = { ...(current?.data || {}) };
  const previousHash = currentLogoHash(settings);
  let logo;
  if (typeof body.logoBase64 === 'string') {
    // Returning existing original bytes is not an upload, including a blocked
    // original. Anything else must pass upload validation; missing assets are
    // stored again rather than acknowledged as already present.
    const unchanged = (await readLogoOriginal(settings))?.dataUrl === body.logoBase64;
    if (!unchanged) {
      logo = parseLogo(body.logoBase64);
      if (!logo) return c.json({ error: LOGO_ERROR }, 400);
    }
  }
  // Move a logo an earlier version kept inline into its own asset on the next
  // save, so settings stay small. An inline value that can't be shown is kept,
  // never silently deleted; removing or replacing the logo clears it.
  const legacy = settings.logoHash ? null : legacyLogo(settings);
  if (!logo && legacy && body.logoBase64 !== null) logo = { ...legacy, legacy: true };
  if (theme !== undefined) settings.theme = theme;
  if (themePatch !== undefined) {
    const merged = publicTheme(settings.theme) || {};
    // Older clients persisted matching accents explicitly. Their meaning is
    // still Match primary when a later client changes only the primary.
    if (merged.accent === merged.primary) delete merged.accent;
    for (const [key, value] of Object.entries(themePatch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    settings.theme = merged;
  }
  if (logo) {
    settings.logoHash = logo.hash;
    delete settings.logoBase64;
  } else if (body.logoBase64 === null) {
    delete settings.logoHash;
    delete settings.logoBase64;
  }
  if (body.classroomName !== undefined) {
    settings.classroomName = body.classroomName.trim();
    settings.logoAlt = settings.classroomName; // backward compat
  }
  try {
    await db.putBrandingSettings(settings, current?.version || 0, { logo, previousLogoHash: previousHash });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return c.json({ error: 'Settings changed in another session. Retry saving.' }, 409);
    throw error;
  }
  return c.json({ ok: true, branding: await publicBranding(settings) });
});


// ── Slack integration moved to plugins/slack/ ──
// Slack endpoints now live at /v1/plugins/slack/admin/* via the plugin registry.
// A backwards-compat shim in server/src/index.js re-routes /v1/admin/slack/* for
// one release. See plugins/slack/server/index.js.

// ── Plugin admin endpoints ──

// GET /v1/admin/plugins — list all known plugins, including disabled and load-failed.
// writeOnly settings (e.g. Slack's bot token) are stripped from responses; the host
// is the source of truth for those values, the client never needs them back.
admin.get('/v1/admin/plugins', async (c) => {
  await pluginRegistry.reconcile({ force: true });
  return c.json(pluginRegistry.list().map((e) => {
    const view = pluginRegistry.publicView(e);
    return { ...view, settings: pluginRegistry.sanitizeSettings(e) };
  }));
});

// PUT /v1/admin/plugins/:id/activation — enable/disable a plugin.
admin.put('/v1/admin/plugins/:id/activation', async (c) => {
  const id = c.req.param('id');
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'JSON body required' }, 400);
  }
  if (typeof body?.enabled !== 'boolean') {
    return c.json({ error: 'enabled (boolean) is required' }, 400);
  }
  const { enabled } = body;
  try {
    const entry = await pluginRegistry.setEnabled(id, enabled);
    return c.json(pluginRegistry.publicView(entry));
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /v1/admin/plugins/:id/uninstall-data — run the plugin's onUninstall
// hook and clear its activation/settings entry. Plugin must be disabled first
// (registry refuses otherwise). Body: { confirm: '<plugin id>' } — the admin
// must type the plugin id to confirm, mirroring GitHub's repo-deletion gate.
// Audit-logged.
admin.post('/v1/admin/plugins/:id/uninstall-data', async (c) => {
  const id = c.req.param('id');
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'JSON body required' }, 400); }
  if (body?.confirm !== id) {
    return c.json({ error: `Type the plugin id (${id}) in "confirm" to proceed` }, 400);
  }
  const adminUser = c.get('user');
  try {
    await pluginRegistry.uninstallData(id);
  } catch (err) {
    logger.error('plugin_uninstall_failed', { pluginId: id, error: err.message });
    return c.json({ error: err.message }, 400);
  }
  await db.createAuditLog({
    action: 'plugin_data_uninstalled',
    userId: adminUser.userId,
    email: adminUser.email,
    performedBy: adminUser.userId,
    details: { pluginId: id },
  });
  return c.json({ ok: true });
});

// PUT /v1/admin/plugins/:id/settings — update plugin settings.
admin.put('/v1/admin/plugins/:id/settings', async (c) => {
  const id = c.req.param('id');
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'JSON body required' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'settings object required' }, 400);
  }
  // writeOnly fields (e.g. a bot token) are never sent to the client, so a
  // panel saving other settings can't include them. Keep the stored value
  // when the body leaves one out; an explicit null still clears it.
  const current = pluginRegistry.get(id);
  const schemaProps = current?.manifest?.settingsSchema?.properties || {};
  for (const [key, def] of Object.entries(schemaProps)) {
    if (def?.writeOnly && !(key in body) && current.settings?.[key] !== undefined) body[key] = current.settings[key];
  }
  try {
    const entry = await pluginRegistry.updateSettings(id, body);
    return c.json({ ...pluginRegistry.publicView(entry), settings: pluginRegistry.sanitizeSettings(entry) });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /v1/admin/stats/lessons — lesson pacing + learner engagement KPIs
//
// Powers the admin dashboard at `/plato`. Two families of metrics:
//   - Pacing: how on-target completed lessons are (on-target rate, over-target
//     count, extended-lesson count). MAX_EXCHANGES is a design target, never a
//     cutoff. `extendedThreshold` (2x target) is informational only — a lesson
//     that runs that long signals a lesson-design mismatch, not a coach
//     failure.
//   - Engagement: `pctStarted` (target >90%) and `pctCompletedHalf` (target
//     >50%). Denominator is non-admin users; "started" = ≥1 lessonKB:* of any
//     status; "completed half" = lessonsCompleted / lessonsAvailable > 0.5
//     (strict — exactly 50% does not count).
//
// Response shape: a flat object with all metric fields plus a `computedAt`
// ISO timestamp (server-generated). The dashboard renders this directly.
//
// Caching: stale-while-revalidate (see server/src/lib/lesson-stats-cache.js).
// Fresh window 10 min; stale window 10 min – 24 h serves cached + fires an
// async Lambda self-invoke for refresh; older than 24 h or missing recomputes
// synchronously. The fan-in (every user × every sync-data item) means the
// recompute should never be on the hot path.
//
// `?refresh=1` bypasses the cache and recomputes synchronously — the dashboard's
// Refresh button uses it. Admin-gated like everything under /v1/admin.

// Pure aggregation — no Hono, no cache, no auth. Exported so the async-refresh
// path (server/src/index.js handler dispatching a self-invoke) can call it
// directly without going through the HTTP layer.
export async function computeLessonStats() {
  const extendedThreshold = MAX_EXCHANGES * 2;
  const users = await db.listAllUsers();
  const systemItems = await db.getAllSyncData('_system');
  // Only published (public) lessons feed any KPI. A learner's completion
  // counts iff its lesson id maps to a public `_system:lesson:*` record —
  // drafts, privates (even when shared), and custom lessons are all excluded.
  const publicIds = publicLessonIds(systemItems);
  const lessonsAvailable = publicIds.size; // same denominator for every learner

  // Pacing aggregates
  let withinTarget = 0;
  let overTarget = 0;
  let extendedLessons = 0; // completed lessons that ran past 2× target
  let totalExchangesWithin = 0;
  let totalExchangesOver = 0;
  let activeLessons = 0;
  const durations = []; // in minutes

  // Engagement aggregates (#TARGET_STARTED_PCT / #TARGET_COMPLETED_HALF_PCT)
  let activeLearners = 0;       // non-admin users
  let learnersStarted = 0;      // ≥1 lessonKB:* record of any status
  let learnersCompletedHalf = 0; // completed > 50% of lessons available to them
  const byLessonRaw = new Map();

  // One bulk `lessonKB:` read for the whole classroom (PR-8), grouped by
  // user. `messages:*` transcripts are fetched lazily, one lesson at a time,
  // only for a completed public lesson whose KB lacks startedAt/completedAt
  // (the legacy duration fallback below) — never for every user up front.
  const kbByUser = new Map();
  for (const item of await db.getSyncDataByPrefixForAllUsers('lessonKB:')) {
    if (!kbByUser.has(item.userId)) kbByUser.set(item.userId, []);
    kbByUser.get(item.userId).push(item);
  }

  for (const user of users) {
    const isLearner = normalizeRole(user.role) === 'learner';
    const kbItems = kbByUser.get(user.userId) || [];
    let userHasStarted = false;
    let userCompleted = 0;

    for (const item of kbItems) {
      const lessonId = item.dataKey.slice('lessonKB:'.length);
      if (!publicIds.has(lessonId)) continue;
      const kb = item.data;
      if (!kb) continue;
      userHasStarted = true;
      if (kb.status === 'completed') {
        userCompleted++;
        const exchanges = kb.activitiesCompleted || 0;
        const lessonEntry = byLessonRaw.get(lessonId) || { completions: 0, totalExchanges: 0, overTarget: 0 };
        lessonEntry.completions++;
        lessonEntry.totalExchanges += exchanges;
        if (exchanges > MAX_EXCHANGES) lessonEntry.overTarget++;
        byLessonRaw.set(lessonId, lessonEntry);
        if (exchanges <= MAX_EXCHANGES) {
          withinTarget++;
          totalExchangesWithin += exchanges;
        } else {
          overTarget++;
          totalExchangesOver += exchanges;
          if (exchanges >= extendedThreshold) extendedLessons++;
        }
        if (kb.startedAt && kb.completedAt) {
          durations.push((kb.completedAt - kb.startedAt) / 60000);
        } else {
          const msgItem = await db.getSyncData(user.userId, `messages:${lessonId}`);
          const msgs = msgItem?.data;
          if (Array.isArray(msgs) && msgs.length >= 2) {
            const first = msgs[0]?.timestamp;
            const last = msgs[msgs.length - 1]?.timestamp;
            if (first && last) durations.push((last - first) / 60000);
          }
        }
      } else {
        activeLessons++;
      }
    }

    if (isLearner) {
      activeLearners++;
      if (userHasStarted) learnersStarted++;
      if (lessonsAvailable > 0 && userCompleted / lessonsAvailable > 0.5) learnersCompletedHalf++;
    }
  }

  const totalCompletions = withinTarget + overTarget;
  const avgDurationMinutes = durations.length
    ? +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)
    : null;
  const byLesson = {};
  for (const [lessonId, entry] of byLessonRaw.entries()) {
    byLesson[lessonId] = {
      completions: entry.completions,
      avgExchanges: entry.completions ? +(entry.totalExchanges / entry.completions).toFixed(1) : null,
      overTarget: entry.overTarget,
    };
  }

  return {
    totalCompletions,
    withinTarget,
    overTarget,
    extendedLessons, // subset of overTarget that ran past 2× target — informational
    exchangeTarget: MAX_EXCHANGES,
    extendedThreshold,
    avgExchangesPerCompletion: totalCompletions ? +((totalExchangesWithin + totalExchangesOver) / totalCompletions).toFixed(1) : null,
    avgExchangesWithinTarget: withinTarget ? +(totalExchangesWithin / withinTarget).toFixed(1) : null,
    avgExchangesOverTarget: overTarget ? +(totalExchangesOver / overTarget).toFixed(1) : null,
    avgDurationMinutes,
    activeLessons,
    byLesson,
    // Engagement KPIs
    activeLearners,
    learnersStarted,
    learnersCompletedHalf,
    pctStarted: activeLearners > 0 ? +((learnersStarted / activeLearners) * 100).toFixed(1) : null,
    pctCompletedHalf: activeLearners > 0 ? +((learnersCompletedHalf / activeLearners) * 100).toFixed(1) : null,
    targetStartedPct: 90,
    targetCompletedHalfPct: 50,
  };
}

export async function recomputeAndCacheLessonStats() {
  const stats = await computeLessonStats();
  const computedAt = new Date().toISOString();
  await db.putSyncData('_system', 'stats:lessons', { computedAt, stats });
  return { computedAt, stats };
}

admin.get('/v1/admin/stats/lessons', async (c) => {
  const force = new URL(c.req.url).searchParams.get('refresh') === '1';
  if (!force) {
    const cached = await db.getSyncData('_system', 'stats:lessons');
    const status = classifyCache(cached);
    // byLesson was added after the first cache writes. A fresh payload without
    // it would hide per-lesson pacing on /plato/lessons until the 24h expiry.
    const hasByLesson = !!cached?.data?.stats && Object.hasOwn(cached.data.stats, 'byLesson');
    if (hasByLesson && status === 'fresh') {
      return c.json({ ...cached.data.stats, computedAt: cached.data.computedAt });
    }
    if (hasByLesson && status === 'stale') {
      if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
        await kickoffAsyncRefresh(); // The enqueue must finish before the response.
        return c.json({ ...cached.data.stats, computedAt: cached.data.computedAt });
      }
      // Off Lambda, post-response work isn't reliable (Cloud Run CPU
      // throttling), so start/join the single-flight recompute and await it
      // briefly: fresh if it lands within 2 s, stale otherwise (PR-8).
      const refreshed = await refreshStaleLessonStats(() => recomputeAndCacheLessonStats());
      if (refreshed) {
        return c.json({ ...refreshed.stats, computedAt: refreshed.computedAt });
      }
      return c.json({ ...cached.data.stats, computedAt: cached.data.computedAt });
    }
  }
  const { computedAt, stats } = await recomputeAndCacheLessonStats();
  return c.json({ ...stats, computedAt });
});

// GET /v1/admin/users/:userId/stats — per-user activity metrics for the
// admin user-detail panel (issue #136). Computed on demand from sync-data;
// no precomputation. Stats are all-time: `days` (default 30) is only echoed
// back as `windowDays`, and the panel doesn't claim a window.
//
// Duration is exchange-based (activitiesCompleted × MINS_PER_EXCHANGE) to
// match `/v1/admin/stats/lessons` and AdminHome — wall-clock minutes inflate
// from multi-session lessons. `lastActiveAt` is the user's most recent
// activity timestamp (updated on login + refresh, per the denormalization policy).
admin.get('/v1/admin/users/:userId/stats', async (c) => {
  const userId = c.req.param('userId');
  const user = await db.getUserById(userId);
  if (!user) return c.json({ error: 'User not found' }, 404);

  const url = new URL(c.req.url);
  const daysParam = parseInt(url.searchParams.get('days') || '30', 10);
  const days = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 365 ? daysParam : 30;

  // Lesson name lookup
  const systemItems = await db.getAllSyncData('_system');
  const publicIds = publicLessonIds(systemItems);
  const lessonNames = new Map();
  for (const item of systemItems) {
    if (item.dataKey?.startsWith('lesson:')) {
      const id = item.dataKey.slice('lesson:'.length);
      lessonNames.set(id, item.data?.name || id);
    }
  }

  const syncItems = await db.getSyncDataByPrefix(userId, 'lessonKB:');
  let lessonsCompleted = 0;
  const lessonDurations = []; // { lessonId, lessonName, exchanges, minutes, completedAt }

  for (const item of syncItems) {
    const lessonId = item.dataKey.slice('lessonKB:'.length);
    if (!publicIds.has(lessonId)) continue; // only published lessons count
    const kb = item.data;
    if (!kb || kb.status !== 'completed') continue;
    lessonsCompleted++;
    const exchanges = kb.activitiesCompleted || 0;
    const minutes = +(exchanges * MINS_PER_EXCHANGE).toFixed(1);
    const completedAtMs = typeof kb.completedAt === 'number' ? kb.completedAt
      : typeof kb.completedAt === 'string' ? Date.parse(kb.completedAt)
      : null;
    lessonDurations.push({
      lessonId,
      lessonName: lessonNames.get(lessonId) || lessonId,
      exchanges, minutes,
      completedAt: completedAtMs ? new Date(completedAtMs).toISOString() : null,
    });
  }

  // Percentiles over all completed lessons (career stats, not window-scoped)
  const sorted = lessonDurations.map((l) => l.minutes).sort((a, b) => a - b);
  const pct = (p) => {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  };

  lessonDurations.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

  return c.json({
    userId,
    windowDays: days,
    lessonsCompleted,
    lessonsAvailable: publicIds.size,
    lastActiveAt: user.lastActiveAt || null,
    completionMinutesP50: pct(50),
    completionMinutesP90: pct(90),
    lessonDurations,
  });
});

// GET /v1/admin/logs — recent server errors/warnings for the pilot agent.
// Merges the diagnostic buffer with the runtime log service. Cloud Run reads
// Cloud Logging across revisions; Lambda retains CloudWatch. Reader errors are
// explicit and never fall back to a different deployment or a healthy status.
admin.get('/v1/admin/logs', async (c) => {
  const url = new URL(c.req.url);
  const rawSince = url.searchParams.get('since');
  const levelParam = url.searchParams.get('level');
  const limitParam = parseInt(url.searchParams.get('limit') || '200', 10);
  const cloudwatchParam = url.searchParams.get('cloudwatch');
  const view = url.searchParams.get('view') || 'both';

  const level = ['error', 'warn', 'info'].includes(levelParam) ? levelParam : undefined;
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 200, 1), 1000);
  const remoteSource = process.env.K_SERVICE ? 'cloud-logging' : 'cloudwatch';
  const includeRemote = remoteSource === 'cloud-logging' ? url.searchParams.get('cloudlogging') !== '0' : cloudwatchParam !== '0';

  let since;
  if (rawSince) {
    const t = new Date(rawSince).getTime();
    if (!Number.isFinite(t)) return c.json({ error: 'Invalid since parameter' }, 400);
    since = new Date(t).toISOString();
  } else {
    since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }

  const bufferEntries = logger.recent({ since, level, limit: logger._bufferSize() }).map((e) => ({ ...e, source: 'buffer' }));

  let cloudwatch = { logGroups: [], error: null };
  let cloudlogging = null;
  let cwEntries = [];
  if (includeRemote && remoteSource === 'cloud-logging') {
    const result = await fetchCloudLoggingLogs({ since });
    const { entries, ...status } = result;
    cloudlogging = status;
    cwEntries = entries.filter(e => !level || e.level === level);
  } else if (includeRemote) {
    const cw = await fetchCloudWatchLogs({ since });
    cloudwatch = { logGroups: cw.logGroups, error: cw.error };
    cwEntries = (cw.entries || []).filter((e) => !level || e.level === level);
  }

  // Merge, dedupe by logId (logger emits logId to stdout so events appearing
  // in both the buffer and CloudWatch share an ID). Track per-logId sources
  // so groups can report "buffer", "cloudwatch", or both accurately.
  const byLogId = new Map();
  const sourcesByLogId = new Map();
  function recordSource(logId, source) {
    let set = sourcesByLogId.get(logId);
    if (!set) { set = new Set(); sourcesByLogId.set(logId, set); }
    set.add(source);
  }
  for (const e of bufferEntries) {
    const identity = logEntryIdentity(e);
    byLogId.set(identity, e); // buffer wins on meta
    recordSource(identity, 'buffer');
  }
  for (const e of cwEntries) {
    const identity = logEntryIdentity(e);
    if (!byLogId.has(identity)) byLogId.set(identity, e);
    recordSource(identity, remoteSource);
  }
  const entries = [...byLogId.values()]
    .map((e) => ({ ...e, source: [...sourcesByLogId.get(logEntryIdentity(e))].join('+') }))
    .sort((a, b) => b.ts.localeCompare(a.ts));

  // Build groups across both sources.
  const groups = new Map();
  for (const e of entries) {
    const srcSet = sourcesByLogId.get(logEntryIdentity(e));
    const g = groups.get(e.code);
    if (!g) {
      groups.set(e.code, {
        code: e.code,
        level: e.level,
        count: 1,
        firstSeen: e.ts,
        lastSeen: e.ts,
        sources: [...srcSet],
        sample: e,
      });
    } else {
      g.count++;
      if (e.ts < g.firstSeen) g.firstSeen = e.ts;
      if (e.ts > g.lastSeen) { g.lastSeen = e.ts; g.sample = e; }
      for (const s of srcSet) if (!g.sources.includes(s)) g.sources.push(s);
    }
  }
  const groupsList = [...groups.values()].sort((a, b) => b.count - a.count);

  const counts = { error: 0, warn: 0, info: 0 };
  for (const e of entries) {
    if (Object.hasOwn(counts, e.level)) counts[e.level]++;
  }

  const windowMs = Date.now() - new Date(since).getTime();
  const response = {
    windowHours: +(windowMs / 3600000).toFixed(2),
    since,
    counts,
    buffer: { size: logger._bufferSize(), used: bufferEntries.length },
    cloudwatch,
    cloudlogging,
    remoteSource,
  };
  if (view !== 'entries') response.groups = groupsList;
  if (view !== 'groups') response.entries = entries.slice(0, limit);

  return c.json(response);
});

export default admin;
