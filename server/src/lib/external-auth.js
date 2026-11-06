/**
 * Provider-neutral external-account admission and session issuance.
 *
 * Auth plugins verify their own provider token and pass only the resulting
 * identity here. Core retains account lookup/creation, invitations, roles,
 * classroom setup, Slack linkage, auditing, and plato token semantics.
 */

import { randomBytes } from 'node:crypto';
import db from './db.js';
import { generateUserId, generateRefreshToken, hashToken } from './crypto.js';
import { hashPassword } from './password.js';
import { signAccessToken } from './jwt.js';
import { DEFAULT_THEME, seedDefaultContent } from './seed.js';
import { classroomNameError } from './branding.js';
import { ADMIN_EMAIL } from '../config.js';
import { getFieldDefinitions, mergeFieldValues } from './user-fields.js';
import { validateUsername, generateUsername } from './usernames.js';
import pluginRegistry from './plugins/registry.js';

function response(status, body) {
  return { status, body };
}

function isOperatorEmail(email) {
  return Boolean(ADMIN_EMAIL) && email === ADMIN_EMAIL.trim().toLowerCase();
}

async function issueSession(user, status = 200, extra = {}) {
  const accessToken = await signAccessToken(user.userId, user.role);
  const refreshToken = generateRefreshToken();
  await db.storeRefreshToken(hashToken(refreshToken), user.userId, hashToken(user.passwordHash || ''));
  return response(status, {
    accessToken,
    refreshToken,
    user: {
      userId: user.userId,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
    },
    ...extra,
  });
}

async function recordActivity(userId, email, action) {
  try {
    await db.createAuditLog({ action, userId, email, performedBy: userId });
  } catch { /* Activity/audit writes are best-effort. */ }
  try {
    await db.setUserActivityField(userId, 'lastActiveAt', new Date().toISOString());
  } catch { /* Activity/audit writes are best-effort. */ }
}

/**
 * @param {{provider:string, subject:string, email:string, emailVerified:boolean, name?:string}} identity
 * @param {object} options onboarding fields supplied by the host auth surface
 */
export async function completeExternalAuth(identity, options = {}) {
  if (!identity || typeof identity !== 'object') return response(400, { error: 'Verified external identity is required' });
  const provider = typeof identity.provider === 'string' ? identity.provider.trim().toLowerCase() : '';
  const subject = typeof identity.subject === 'string' ? identity.subject.trim() : '';
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(provider) || !subject) {
    return response(400, { error: 'Verified external identity is required' });
  }
  const email = typeof identity.email === 'string' ? identity.email.toLowerCase().trim() : '';
  if (!email || identity.emailVerified !== true) {
    return response(400, { error: 'A verified external email address is required' });
  }

  const displayName = (typeof options.name === 'string' && options.name.trim())
    || (typeof identity.name === 'string' && identity.name.trim())
    || email.split('@')[0];
  const classroomName = options.classroomName;
  const rawUsername = options.username;

  // Initial classroom setup.
  const count = await db.countUsers();
  if (count === 0) {
    const nameError = classroomName === undefined ? null : classroomNameError(classroomName);
    if (nameError) return response(400, { error: nameError });
    const username = rawUsername ? rawUsername.toLowerCase() : generateUsername();
    if (rawUsername) {
      const usernameError = validateUsername(rawUsername);
      if (usernameError) return response(400, { error: usernameError });
    }

    const userId = generateUserId();
    const passwordHash = await hashPassword(randomBytes(24).toString('hex'));
    const user = { userId, email, username, passwordHash, name: displayName, role: 'admin' };
    await db.createUser(user);
    await pluginRegistry.emit('userCreated', { userId, email, role: 'admin' });

    try { await seedDefaultContent(); } catch (error) {
      console.error('Content seed failed (non-fatal):', error.message);
    }
    if (classroomName?.trim()) {
      try {
        const current = await db.getSyncData('_system', 'settings');
        const settings = {
          ...(current?.data || {}),
          classroomName: classroomName.trim(),
          logoAlt: classroomName.trim(),
        };
        if (!settings.theme) settings.theme = { ...DEFAULT_THEME };
        await db.putSyncData('_system', 'settings', settings, current?.version || 0);
      } catch (error) {
        console.error('Classroom name save failed (non-fatal):', error.message);
      }
    }
    return issueSession(user, 201, { isNewSetup: true });
  }

  // Existing accounts keep their role and need no new invitation.
  const existingUser = await db.getUserByEmail(email);
  if (existingUser) {
    const result = await issueSession(existingUser);
    await recordActivity(existingUser.userId, existingUser.email, `user_login_${provider}`);
    return result;
  }

  // New accounts follow the same invitation boundary as password signup.
  const inviteToken = options.inviteToken;
  let invite = null;
  let inviteExpired = false;
  if (inviteToken) {
    invite = await db.getInvite(inviteToken);
    if (!invite || invite.status !== 'pending' || (invite.ttl && invite.ttl < Math.floor(Date.now() / 1000))) {
      return response(400, { error: 'Invalid or expired invite' });
    }
    if (invite.email && invite.email.toLowerCase() !== email) {
      return response(400, { error: 'This invite is for a different email address' });
    }
  } else {
    const byEmail = await db.getInviteByEmail(email);
    if (byEmail && byEmail.status === 'pending') {
      if (!byEmail.ttl || byEmail.ttl >= Math.floor(Date.now() / 1000)) invite = byEmail;
      else inviteExpired = true;
    }
  }

  const operator = isOperatorEmail(email);
  let waitlistEntry = null;
  if (!invite) waitlistEntry = await db.getWaitlistEntryByEmail(email);

  if (!invite && !operator) {
    return response(403, {
      error: 'Membership is by invitation only. Ask your program admin for an invitation.',
      code: 'invite_required',
      email,
      name: typeof identity.name === 'string' ? identity.name.trim() : '',
      waitlisted: Boolean(waitlistEntry),
      inviteExpired,
    });
  }

  let username = rawUsername ? rawUsername.toLowerCase() : null;
  if (username) {
    const usernameError = validateUsername(username);
    if (usernameError) return response(400, { error: usernameError });
    if (await db.getUserByUsername(username)) return response(409, { error: 'Username already taken' });
  } else {
    const emailPrefix = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    let candidate = emailPrefix.length >= 3 && !emailPrefix.startsWith('-') && !emailPrefix.endsWith('-') && !emailPrefix.startsWith('_') && !emailPrefix.endsWith('_')
      ? emailPrefix
      : generateUsername();
    while (await db.getUserByUsername(candidate)) candidate = generateUsername();
    username = candidate;
  }

  const profile = invite?.profile || waitlistEntry?.profile || null;
  let customFields = {};
  if (options.customFields !== undefined || profile?.customFields) {
    const settings = await db.getSyncData('_system', 'settings');
    const merged = mergeFieldValues(getFieldDefinitions(settings?.data), profile?.customFields || {}, options.customFields);
    if (merged.error) return response(400, { error: merged.error });
    customFields = merged.values;
  }

  let profileGroup = null;
  if (profile?.userGroup) {
    const settings = await db.getSyncData('_system', 'settings');
    if ((settings?.data?.userGroups || []).includes(profile.userGroup)) profileGroup = profile.userGroup;
  }

  if (invite?.isLink) {
    try {
      await db.incrementLinkUsage(invite.inviteToken);
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        return response(400, { error: 'This invite link has reached its usage limit' });
      }
      throw error;
    }
  }

  const userId = generateUserId();
  const passwordHash = await hashPassword(randomBytes(24).toString('hex'));
  const finalName = displayName || profile?.name || email.split('@')[0];
  const assignedRole = operator ? 'admin' : 'user';
  const user = {
    userId,
    email,
    username,
    passwordHash,
    name: finalName,
    userGroup: options.userGroup || profileGroup || null,
    role: assignedRole,
    slackUserId: invite?.slackUserId || null,
    customFields,
  };
  await db.createUser(user);
  await pluginRegistry.emit('userCreated', { userId, email, role: assignedRole });

  if (invite?.isLink) {
    const updated = await db.getInvite(invite.inviteToken);
    if (updated?.maxUsages && updated.usageCount >= updated.maxUsages) await db.markInviteUsed(invite.inviteToken);
  } else if (invite) {
    await db.markInviteUsed(invite.inviteToken);
  } else if (waitlistEntry) {
    try { await db.deleteInvite(waitlistEntry.inviteToken); } catch { /* best-effort wait-list cleanup */ }
  }

  await recordActivity(userId, email, `user_created_${provider}`);
  return issueSession(user, 201);
}
