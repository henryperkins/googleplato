/**
 * Admin messages (#389): one-off announcements to everyone, people with
 * certain roles, a group, or specific people, shown in the classroom (the
 * bell, and optionally a pop-up at sign-in) and/or emailed.
 *
 * A message is `_system:message:<id>` =
 *   { subject, body,
 *     audience: { type: 'all' | 'role' | 'group' | 'users', roles?, group?, userIds?, allRoles? },
 *     inApp, email, important, status: 'sending' | 'failed' | 'sent' | 'closed', counts?, createdAt, createdBy, createdByName }
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
 * Closed messages cannot deliver again. Admins can stop retrying; otherwise
 * the retry window expires after 30 days. Closing prunes pending claims and
 * bounds finished receipts to 49 while preserving reminder/digest guards.
 * Read acknowledgements are limited to the caller's 50 visible messages.
 */
import { createHash, randomBytes } from 'node:crypto';
import defaultDb from './db.js';
import { normalizeRole, ROLES } from './permissions.js';
import { nameFields } from './names.js';
import { APP_URL } from '../config.js';
import { getClassroom, escapeHtml } from './email.js';
import {
  validateTemplate, renderEmail, sendNotificationEmail, readNotifyState, updateNotifyState,
  unsubscribeUrl, UNSUBSCRIBE_KINDS, isUncertainEmailError,
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
    const existing = await db.getSyncData('_system', `message:${id}`, { consistentRead: true });
    return { id, ...existing.data, duplicate: true };
  }
  return { id, ...record };
}

export async function listMessages(db = defaultDb) {
  // The current snapshot determines which terminal messages may lose receipts.
  // A lagging DynamoDB replica must never resurrect delivery after pruning.
  const items = await db.getSyncDataByPrefix('_system', 'message:', { consistentRead: true });
  let closed = false;
  const messages = [];
  for (const item of items) {
    const id = item.dataKey.slice('message:'.length);
    let data = item.data;
    if (retryExpired(data) && !(data.deliveryLease?.until > Date.now())) {
      try {
        data = { ...data, status: 'closed', closedAt: new Date().toISOString(), closeReason: 'expired', deliveryLease: null, deliveryError: null };
        await db.putSyncData('_system', item.dataKey, data, item.version, { strictVersion: true });
        closed = true;
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
        data = (await db.getSyncData('_system', item.dataKey, { consistentRead: true }))?.data;
      }
    }
    if (data) messages.push({ id, ...data });
  }
  if (closed) await pruneFinishedState(db, finishedIds(messages));
  return messages.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
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
  const user = await db.getUserById(userId);
  if (!user) return { read: 0 };
  const visible = new Set((await messagesFor(user, db)).map(message => message.id));
  const clean = [...new Set((Array.isArray(ids) ? ids : []).filter(id =>
    typeof id === 'string' && /^msg_[a-z0-9]{8,40}$/.test(id) && visible.has(id)))];
  const now = new Date().toISOString();
  await updateNotifyState(userId, state => ({ ...state, read: {
    ...Object.fromEntries(Object.entries(state.read || {}).filter(([id]) => visible.has(id))),
    ...Object.fromEntries(clean.map(id => [id, now])),
  } }), db);
  return { read: clean.length };
}

const fill = (s, vars) => s.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));

const DELIVERY_LEASE_MS = 10 * 60 * 1000;
const FINISHED_RECEIPTS_KEPT = 49;
export const MESSAGE_RETRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const retryExpired = message => message.email && !['sent', 'closed'].includes(message.status)
  && Date.parse(message.createdAt || '') + MESSAGE_RETRY_WINDOW_MS <= Date.now();
const finishedIds = messages => new Set(messages.filter(message => !message.email || ['sent', 'closed'].includes(message.status)).map(message => message.id));

async function pruneFinishedState(db, finished, users = null) {
  for (const user of users || await db.listAllUsers()) {
    await updateNotifyState(user.userId, state => {
      const emailed = keptReceipts(state.emailed, finished);
      const emailPending = Object.fromEntries(Object.entries(state.emailPending || {}).filter(([id]) => !finished.has(id)));
      if (Object.keys(emailed).length === Object.keys(state.emailed || {}).length
        && Object.keys(emailPending).length === Object.keys(state.emailPending || {}).length) return state;
      return { ...state, emailed, emailPending };
    }, db);
  }
}

/** Stop further attempts, then prune claims only once delivery is durably closed. */
export async function closeMessage(id, db = defaultDb) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = await db.getSyncData('_system', `message:${id}`, { consistentRead: true });
    if (!item) return { missing: true };
    if (item.data.status === 'sent') return { id, ...item.data };
    if (item.data.status !== 'closed') {
      if (item.data.deliveryLease?.until > Date.now()) return { active: true };
      try {
        await db.putSyncData('_system', `message:${id}`, { ...item.data, status: 'closed', closedAt: new Date().toISOString(), closeReason: 'admin', deliveryLease: null, deliveryError: null }, item.version, { strictVersion: true });
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
        continue;
      }
    }
    const messages = await listMessages(db);
    await pruneFinishedState(db, finishedIds(messages));
    return messages.find(message => message.id === id);
  }
  return { active: true };
}

/**
 * Finished delivery: in-app only, sent or closed. Expired retry windows are
 * durably closed before their receipts or pending claims can be pruned.
 */
async function finishedMessageIds(db) {
  return finishedIds(await listMessages(db));
}

/**
 * A recipient's `emailed` receipts, minus the oldest receipts of finished
 * messages. A retry treats a missing receipt as "not sent yet", so a message
 * that can still be retried (or one newer than the `finished` snapshot) keeps
 * every receipt, however many messages follow it. Only finished messages'
 * receipts are capped.
 */
function keptReceipts(emailed, finished) {
  const entries = Object.entries(emailed || {});
  const done = entries.filter(([messageId]) => finished.has(messageId))
    .sort((a, b) => b[1].localeCompare(a[1])).slice(0, FINISHED_RECEIPTS_KEPT);
  return Object.fromEntries([...done, ...entries.filter(([messageId]) => !finished.has(messageId))]);
}

async function claimDelivery(id, db) {
  const owner = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = await db.getSyncData('_system', `message:${id}`, { consistentRead: true });
    if (!item || !item.data.email || ['sent', 'closed'].includes(item.data.status)) return { skipped: true };
    if (retryExpired(item.data)) {
      const closed = await closeMessage(id, db);
      return closed.active ? { active: true } : { skipped: true };
    }
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
    const item = await db.getSyncData('_system', `message:${id}`, { consistentRead: true });
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
    const [people, classroom, finished] = await Promise.all([recipientsOf(message, db), getClassroom(), finishedMessageIds(db)]);
    counts.recipients = people.length;
    // Repeat terminal cleanup before growing any recipient item. This also
    // recovers a worker that stopped after closing a message but before pruning.
    await pruneFinishedState(db, finished, people);
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
            // Only a known pre-send refusal releases this attempt's claim.
            // An uncertain acknowledgement keeps it: a retry must not repeat
            // a message the provider might already have accepted.
            if (!isUncertainEmailError(error)) {
              await updateNotifyState(u.userId, st => {
                if (st.emailPending?.[id]?.owner !== owner) return st;
                const { [id]: _drop, ...rest } = st.emailPending;
                return { ...st, emailPending: rest };
              }, db).catch(() => {});
            }
            throw error;
          }
          await updateNotifyState(u.userId, st => {
            if (st.emailPending?.[id]?.owner !== owner) return st;
            const { [id]: _drop, ...rest } = st.emailPending;
            return { ...st, emailPending: rest, ...(result.sent ? {
              emailed: { ...keptReceipts(st.emailed, finished), [id]: new Date().toISOString() },
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
    if (!counts.failed) { finished.add(id); await pruneFinishedState(db, finished, people); }
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
