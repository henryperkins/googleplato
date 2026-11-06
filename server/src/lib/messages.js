/**
 * Admin messages (#389): one-off announcements to everyone, people with
 * certain roles, a group, or specific people, shown in the classroom (the
 * bell, and optionally a pop-up at sign-in) and/or emailed.
 *
 * A message is `_system:message:<id>` =
 *   { subject, body,
 *     audience: { type: 'all' | 'role' | 'group' | 'users', roles?, group?, userIds?, allRoles? },
 *     inApp, email, important, status: 'sending' | 'failed' | 'sent', counts?, createdAt, createdBy, createdByName }
 *
 * Who it reaches:
 * - `all` — everyone, any role. `group` — the group's members, any role.
 *   Both carry `allRoles: true`. Messages sent before that flag existed
 *   (stored without it) meant **learners only**, and keep meaning that: the
 *   bell is worked out at read time, so changing them would suddenly show old
 *   learner announcements to staff.
 * - `role` — people whose role is in `roles` (learner, educator, admin, tester).
 * - `users` — the people chosen, any role.
 * Broadcasts (all, role, group) reach only people who joined before the
 * message was sent. In-app delivery is computed at read time from the
 * audience, so nothing is written per recipient. Read state lives in the
 * user's server-only `notify:state` (`read: { [messageId]: iso }`). Email
 * goes out in the `send-message` background job (lib/jobs.js), honoring the
 * `messages` opt-out. A durable execution lease serializes delivery attempts;
 * per-user pending claims are distinct from acknowledged emailed recipients.
 */
import { createHash, randomBytes } from 'node:crypto';
import defaultDb from './db.js';
import { normalizeRole, ROLES } from './permissions.js';
import { nameFields } from './names.js';
import { APP_URL } from '../config.js';
import { getClassroom, escapeHtml } from './email.js';
import {
  validateTemplate, renderEmail, sendNotificationEmail, readNotifyState, updateNotifyState,
  unsubscribeUrl, UNSUBSCRIBE_KINDS,
} from './notifications.js';
import { registerJob } from './jobs.js';

export const MESSAGE_VARIABLES = ['firstName', 'classroomName'];
const MAX_RECIPIENTS_LISTED = 500;
const SEND_CONCURRENCY = 5;

export const newMessageId = () => `msg_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

/** Check a draft. Returns `{ message }` (normalized) or `{ error }`. */
export function validateMessage(body, { groups = [] } = {}) {
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const text = typeof body?.body === 'string' ? body.body.replace(/\r\n/g, '\n').trim() : '';
  const err = validateTemplate(null, { subject, body: text }, MESSAGE_VARIABLES);
  if (err) return { error: err };
  const inApp = body.inApp === true;
  const email = body.email === true;
  if (!inApp && !email) return { error: 'Choose in-app, email, or both' };
  const a = body.audience || {};
  let audience;
  if (a.type === 'all') audience = { type: 'all', allRoles: true };
  else if (a.type === 'role') {
    const roles = ROLES.filter((r) => Array.isArray(a.roles) && a.roles.includes(r));
    if (!roles.length) return { error: 'Choose at least one role' };
    audience = { type: 'role', roles };
  } else if (a.type === 'group') {
    if (!groups.includes(a.group)) return { error: 'Choose one of the classroom’s groups' };
    audience = { type: 'group', group: a.group, allRoles: true };
  } else if (a.type === 'users') {
    const ids = [...new Set((Array.isArray(a.userIds) ? a.userIds : []).filter((x) => typeof x === 'string'))];
    if (!ids.length) return { error: 'Choose at least one person' };
    if (ids.length > MAX_RECIPIENTS_LISTED) return { error: `Choose at most ${MAX_RECIPIENTS_LISTED} people, or send to a group` };
    audience = { type: 'users', userIds: ids };
  } else {
    return { error: 'Choose who gets this message' };
  }
  return { message: { subject, body: text, audience, inApp, email, important: inApp && body.important === true } };
}

/** Is this user one of the message's recipients? */
export function isRecipient(message, user) {
  const a = message.audience || {};
  if (a.type === 'users') return a.userIds.includes(user.userId);
  // People who joined later don't get older broadcasts.
  if (user.createdAt && message.createdAt && user.createdAt > message.createdAt) return false;
  const role = normalizeRole(user.role);
  if (a.type === 'role') return Array.isArray(a.roles) && a.roles.includes(role);
  // Without allRoles (sent before it existed), everyone and groups meant learners.
  if (!a.allRoles && role !== 'learner') return false;
  return a.type === 'all' || (a.type === 'group' && user.userGroup === a.group);
}

export async function recipientsOf(message, db = defaultDb) {
  const users = await db.listAllUsers();
  return users.filter((u) => isRecipient(message, u));
}

/** For the compose screen: how many people, and how many have turned email off. */
export async function previewAudience(audience, db = defaultDb) {
  const now = new Date().toISOString();
  const people = await recipientsOf({ audience, createdAt: now }, db);
  let optedOut = 0;
  for (const u of people) if ((await readNotifyState(u.userId, db)).optOut?.messages) optedOut++;
  return { count: people.length, emailOptedOut: optedOut, sample: people.slice(0, 5).map((u) => nameFields(u).name || u.email) };
}

/**
 * Store a new message. A `requestId` (the compose form sends one per message)
 * makes this idempotent: the same request again returns the stored message
 * with `duplicate: true` instead of sending twice.
 */
export async function createMessage(message, actor, db = defaultDb, { requestId = null } = {}) {
  const id = typeof requestId === 'string' && /^[\w-]{8,64}$/.test(requestId)
    ? `msg_r${createHash('sha256').update(`${actor.userId}:${requestId}`).digest('hex').slice(0, 20)}`
    : newMessageId();
  const record = {
    ...message,
    status: message.email ? 'sending' : 'sent',
    counts: { recipients: (await recipientsOf({ ...message, createdAt: new Date().toISOString() }, db)).length },
    createdAt: new Date().toISOString(),
    createdBy: actor.userId,
    createdByName: nameFields(actor).name || actor.username || actor.email,
  };
  try {
    await db.createSyncData('_system', `message:${id}`, record);
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    const existing = await db.getSyncData('_system', `message:${id}`);
    return { id, ...existing.data, duplicate: true };
  }
  return { id, ...record };
}

export async function listMessages(db = defaultDb) {
  // Prefix query: the bell calls this on every load, and _system also holds
  // every lesson, prompt, and the knowledge base.
  const items = await db.getSyncDataByPrefix('_system', 'message:');
  return items
    .map((i) => ({ id: i.dataKey.slice('message:'.length), ...i.data }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** The in-app messages a user can see, newest first, with `read`. */
export async function messagesFor(user, db = defaultDb) {
  const [all, state, classroom] = await Promise.all([listMessages(db), readNotifyState(user.userId, db), getClassroom()]);
  const read = state.read || {};
  const vars = { firstName: nameFields(user).firstName, classroomName: classroom.name };
  return all.filter((m) => m.inApp && isRecipient(m, user)).slice(0, 50).map((m) => ({
    id: m.id, subject: fill(m.subject, vars), body: fill(m.body, vars),
    important: !!m.important, createdAt: m.createdAt, fromName: m.createdByName, read: !!read[m.id],
  }));
}

export async function markRead(userId, ids, db = defaultDb) {
  const clean = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x.startsWith('msg_')).slice(0, 100);
  if (!clean.length) return { read: 0 };
  const now = new Date().toISOString();
  await updateNotifyState(userId, (s) => ({ ...s, read: { ...(s.read || {}), ...Object.fromEntries(clean.map((id) => [id, now])) } }), db);
  return { read: clean.length };
}

const fill = (s, vars) => s.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));

const DELIVERY_LEASE_MS = 10 * 60 * 1000;

async function claimDelivery(id, db) {
  const owner = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = await db.getSyncData('_system', `message:${id}`);
    if (!item || !item.data.email || item.data.status === 'sent') return { skipped: true };
    if (item.data.deliveryLease?.until > Date.now()) return { active: true };
    const until = Date.now() + DELIVERY_LEASE_MS;
    try {
      await db.putSyncData('_system', `message:${id}`, {
        ...item.data, status: 'sending', deliveryLease: { owner, until },
      }, item.version, { strictVersion: true });
      return { owner, until, message: item.data };
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  return { active: true };
}

// Every renewal/finalization checks durable ownership and the exact version.
// A worker that outlives its lease cannot overwrite a newer attempt's outcome.
async function updateDelivery(id, owner, change, db) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = await db.getSyncData('_system', `message:${id}`);
    if (item?.data.deliveryLease?.owner !== owner) throw new Error('Message delivery ownership changed');
    try {
      await db.putSyncData('_system', `message:${id}`, change(item.data), item.version, { strictVersion: true });
      return;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException' || attempt === 2) throw error;
    }
  }
}

/** The owning `send-message` attempt sends recipients and publishes its outcome. */
export async function sendMessageEmails({ id }, { db = defaultDb, send } = {}) {
  const lease = await claimDelivery(id, db);
  if (!lease.owner) return lease;
  const { owner, message } = lease;
  let renewal = null;
  async function renewLease() {
    if (lease.until > Date.now() + DELIVERY_LEASE_MS / 2) return;
    const until = Date.now() + DELIVERY_LEASE_MS;
    renewal ||= updateDelivery(id, owner, data => ({
      ...data, deliveryLease: { owner, until },
    }), db).then(() => { lease.until = until; }).finally(() => { renewal = null; });
    await renewal;
  }
  const counts = { recipients: 0, emailed: 0, optedOut: 0, blocked: 0, skipped: 0, failed: 0 };
  let finalized = false;
  try {
    const [people, classroom] = await Promise.all([recipientsOf(message, db), getClassroom()]);
    counts.recipients = people.length;
    const queue = [...people];
    async function worker() {
      for (let u = queue.shift(); u; u = queue.shift()) {
        try {
          await renewLease();
          let claimed = false, pending = false, optedOut = false;
          await updateNotifyState(u.userId, st => {
            claimed = false;
            optedOut = !!st.optOut?.messages;
            pending = !!st.emailPending?.[id];
            if (optedOut || st.emailed?.[id] || pending) return st;
            claimed = true;
            return { ...st, emailPending: { ...st.emailPending, [id]: { owner, at: new Date().toISOString() } } };
          }, db);
          if (!claimed) {
            if (optedOut) counts.optedOut++;
            else if (pending) { counts.failed++; counts.pending = (counts.pending || 0) + 1; }
            else counts.emailed++;
            continue;
          }
          const unsubscribe = unsubscribeUrl(u.userId, 'messages');
          const label = UNSUBSCRIBE_KINDS.messages;
          const rendered = renderEmail(message, { firstName: nameFields(u).firstName, classroomName: classroom.name, link: APP_URL }, {
            classroom,
            footerText: `To stop getting ${label} by email, unsubscribe: ${unsubscribe}`,
            footerHtml: `<p style="color: #777; font-size: 12px; line-height: 1.5; margin: 16px 0 0;">Don’t want ${escapeHtml(label)} by email? <a href="${escapeHtml(unsubscribe)}" style="color: #777;">Unsubscribe</a>.</p>`,
          });
          let result;
          try {
            result = await sendNotificationEmail({ to: u.email, ...rendered, classroom, unsubscribe, ...(send ? { send } : {}) });
          } catch (error) {
            // A known failure releases only this attempt's pending claim. A
            // late failure cannot remove another attempt's acknowledged send.
            await updateNotifyState(u.userId, st => {
              if (st.emailPending?.[id]?.owner !== owner) return st;
              const { [id]: _drop, ...rest } = st.emailPending;
              return { ...st, emailPending: rest };
            }, db).catch(() => {});
            throw error;
          }
          await updateNotifyState(u.userId, st => {
            if (st.emailPending?.[id]?.owner !== owner) return st;
            const { [id]: _drop, ...rest } = st.emailPending;
            const recent = Object.entries(st.emailed || {}).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 49);
            return { ...st, emailPending: rest, ...(result.sent ? {
              emailed: { ...Object.fromEntries(recent), [id]: new Date().toISOString() },
            } : {}) };
          }, db);
          if (result.sent) counts.emailed++;
          else if (result.blocked) counts.blocked++;
          else counts.skipped++;
        } catch {
          counts.failed++;
        }
      }
    }
    await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
    await updateDelivery(id, owner, data => ({ ...data,
      deliveryLease: null, deliveryError: counts.failed ? 'Email delivery failed. Retry this message.' : null,
      status: counts.failed ? 'failed' : 'sent', counts,
      ...(counts.failed ? {} : { sentAt: new Date().toISOString() }),
    }), db);
    finalized = true;
    if (counts.failed) throw new Error(`Message delivery failed for ${counts.failed} recipient(s)`);
    return counts;
  } finally {
    if (!finalized) {
      // Setup/storage errors release execution ownership as well. An expired
      // owner never changes the status of a newer run or clears its lease.
      await updateDelivery(id, owner, data => ({ ...data, deliveryLease: null, status: 'failed',
        deliveryError: 'Email delivery failed. Retry this message.', counts,
      }), db).catch(() => {});
    }
  }
}

registerJob('send-message', (payload) => sendMessageEmails(payload));
