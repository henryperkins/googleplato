/**
 * Auto-invite (#379): the signup hook and both Retry actions share one SDK
 * compare-and-set claim. A 60 s lease suppresses same-channel duplicates;
 * random attempt ownership fences late outcomes independently of the clock.
 * Each Slack call gets one bounded 4 s try (slack-client.js).
 */
import { randomUUID } from 'node:crypto';
import { db, updateUserMeta } from '../../../src/lib/plugins/sdk.js';
import { findSlackUserByEmail, inviteToSlackChannel } from './slack-client.js';

const LEASE_MS = 60000;
const MAX_COMPARISONS = 3;

// The SDK updater must return an object. Throwing this private sentinel aborts
// its write without extending the public metadata API or bumping a version.
class SkipWrite extends Error {
  constructor(result = null) { super('Skip Slack metadata write'); this.result = result; }
}

async function mutate(userId, updater) {
  for (let attempt = 0; attempt < MAX_COMPARISONS; attempt++) {
    try {
      await updateUserMeta(userId, 'slack', updater);
      return true;
    } catch (error) {
      if (error instanceof SkipWrite) return error.result;
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  return { status: 'conflict' };
}

async function freshSettings() {
  return (await db.getSyncData('_system', 'plugins:activation'))?.data?.slack?.settings || null;
}

/** Retry selection is advisory; the strong atomic claim is authoritative. */
export function needsRetry(meta, channelId) {
  return !!meta?.autoInvite && (meta.autoInvite.status !== 'invited'
    || !!channelId && meta.autoInvite.channelId !== channelId);
}

export function autoInviteConfigured(settings) {
  return !!(settings?.autoInviteEnabled && settings?.autoInviteChannelId && settings?.botToken);
}

export function isLiveAttempt(record, channelId, now = Date.now()) {
  return record?.status === 'pending' && record.channelId === channelId && Date.parse(record.leaseUntil) > now;
}

function previousAttempt(record) {
  if (!record) return undefined;
  const { status, channelId, at, error } = record;
  return { status, channelId, at, ...(error ? { error } : {}) };
}

/** Invite once as the owning attempt; storage uses the real SDK in every path. */
export async function autoInvite({ userId, email }, settings, deps = {}) {
  const { lookup = findSlackUserByEmail, invite = inviteToSlackChannel, now = Date.now } = deps;
  if (!autoInviteConfigured(settings) || !userId || !email) return null;
  const channelId = settings.autoInviteChannelId;
  const target = { channelId, channelName: settings.autoInviteChannelName || null };
  const attemptId = randomUUID();
  let hadMetadata = false;
  const claim = await mutate(userId, async current => {
    // A CAS loss after explicit metadata deletion is final, not an instruction
    // to recreate that record on the next comparison.
    if (hadMetadata && !current) throw new SkipWrite();
    hadMetadata ||= Boolean(current);
    if (!await db.getUserById(userId, { consistentRead: true })) throw new SkipWrite();
    if (current?.autoInvite?.status === 'invited' && current.autoInvite.channelId === channelId) throw new SkipWrite();
    const time = now();
    if (isLiveAttempt(current?.autoInvite, channelId, time)) throw new SkipWrite({ status: 'in_progress' });
    const previous = previousAttempt(current?.autoInvite);
    return { ...current, autoInvite: {
      status: 'pending', ...target, attemptId,
      at: new Date(time).toISOString(), startedAt: new Date(time).toISOString(), leaseUntil: new Date(time + LEASE_MS).toISOString(),
      ...(previous ? { previousAttempt: previous } : {}),
    } };
  });
  if (claim !== true) return claim;

  // Account deletion can complete between the updater's check and a first
  // create. Re-read both records before any external call and remove only this
  // attempt's orphaned claim; later account deletion cascades normally.
  const claimed = await db.getSyncData(userId, 'userMeta:slack', { consistentRead: true });
  if (claimed?.data?.autoInvite?.attemptId !== attemptId) return null;
  if (!await db.getUserById(userId, { consistentRead: true })) {
    await db.deleteSyncData(userId, 'userMeta:slack', { expectedVersion: claimed.version });
    return null;
  }

  let result;
  try {
    const slackUserId = await lookup(settings.botToken, email);
    if (!slackUserId) result = { status: 'not_in_workspace' };
    else { await invite(settings.botToken, channelId, slackUserId); result = { status: 'invited' }; }
  } catch (error) {
    result = { status: 'failed', error: error?.data?.error || error?.message || 'unknown error' };
  }
  let record;
  const outcome = await mutate(userId, async current => {
    // Discard every nonowner outcome, including success after an owner's
    // failure. Missing metadata never becomes a new record at this boundary.
    if (current?.autoInvite?.attemptId !== attemptId || !await db.getUserById(userId, { consistentRead: true })) throw new SkipWrite();
    record = { ...current.autoInvite, ...result, at: new Date(now()).toISOString() };
    return { ...current, autoInvite: record };
  });
  return outcome === true ? record : outcome;
}

/** Signup waits for the bounded attempt; Slack/storage errors cannot reject it. */
export async function onUserCreated(payload, ctx, { readSettings = freshSettings } = {}) {
  const settings = (await readSettings().catch(() => null)) || ctx?.settings;
  if (!autoInviteConfigured(settings)) return;
  await autoInvite(payload, settings).catch((err) => {
    ctx?.logger?.warn('slack_auto_invite_failed', { error: err?.message });
  });
}
