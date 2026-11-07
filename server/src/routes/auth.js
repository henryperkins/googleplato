import { settleAdmissionGroupAssignment } from '../lib/groups.js';
import { Hono } from 'hono';
import db from '../lib/db.js';
import { normalizeRole } from '../lib/permissions.js';
import { nameFields, readNameInput } from '../lib/names.js';
import { generateUserId, generateRefreshToken, generateResetToken, hashToken } from '../lib/crypto.js';
import { hashPassword, comparePassword } from '../lib/password.js';
import { signAccessToken } from '../lib/jwt.js';
import { sendResetEmail, emailDeliveryEnabled } from '../lib/email.js';
import { DEFAULT_THEME, seedDefaultContent } from '../lib/seed.js';
import { classroomNameError } from '../lib/branding.js';
import { logger } from '../lib/logger.js';
import pluginRegistry from '../lib/plugins/registry.js';
import { getFieldDefinitions, mergeFieldValues } from '../lib/user-fields.js';
import { validateUsername, generateUsername } from '../lib/usernames.js';

const auth = new Hono();

// GET /v1/auth/setup-status — check if initial setup is needed
auth.get('/v1/auth/setup-status', async (c) => {
  const count = await db.countUsers();
  return c.json({ needsSetup: count === 0 });
});

// GET /v1/auth/providers — enabled public auth providers and their explicitly
// allowlisted, non-secret browser configuration. No authentication is required.
auth.get('/v1/auth/providers', async (c) => {
  return c.json(await pluginRegistry.publicAuthProviders());
});

// POST /v1/auth/setup — create the first admin account (only works when no users exist)
auth.post('/v1/auth/setup', async (c) => {
  const count = await db.countUsers();
  if (count > 0) {
    return c.json({ error: 'Setup already completed' }, 400);
  }

  const body = await c.req.json();
  const { email, password, username: rawUsername, classroomName } = body;
  if (!email || !password) {
    return c.json({ error: 'email, first name, and password are required' }, 400);
  }
  const nameInput = readNameInput(body, { required: true });
  if (nameInput.error) return c.json({ error: nameInput.error }, 400);
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }
  const nameError = classroomName === undefined ? null : classroomNameError(classroomName);
  if (nameError) return c.json({ error: nameError }, 400);

  const username = rawUsername ? rawUsername.toLowerCase() : generateUsername();
  if (rawUsername) {
    const usernameErr = validateUsername(rawUsername);
    if (usernameErr) return c.json({ error: usernameErr }, 400);
    const existingUsername = await db.getUserByUsername(rawUsername);
    if (existingUsername) return c.json({ error: 'Username already taken' }, 409);
  }

  const userId = generateUserId();
  const passwordHash = await hashPassword(password);

  await db.createUser({
    userId,
    email: email.toLowerCase(),
    username,
    passwordHash,
    ...nameInput.fields,
    role: 'admin',
  });

  // Emit userCreated so plugins can react. Errors in handlers are caught and
  // logged inside emit() — never bubble up to the user-facing request.
  await pluginRegistry.emit('userCreated', { userId, email: email.toLowerCase(), role: 'admin' });

  // Seed default prompts and lessons
  try { await seedDefaultContent(); } catch (e) {
    console.error('Content seed failed (non-fatal):', e.message);
  }

  // Save classroom name if provided
  if (classroomName?.trim()) {
    try {
      const current = await db.getSyncData('_system', 'settings');
      const settings = { ...(current?.data || {}), classroomName: classroomName.trim(), logoAlt: classroomName.trim() };
      if (!settings.theme) settings.theme = { ...DEFAULT_THEME };
      await db.putSyncData('_system', 'settings', settings, current?.version || 0);
    } catch (e) {
      console.error('Classroom name save failed (non-fatal):', e.message);
    }
  }

  const accessToken = await signAccessToken(userId, 'admin');
  const refreshToken = generateRefreshToken();
  await db.storeRefreshToken(hashToken(refreshToken), userId, hashToken(passwordHash));

  return c.json({
    accessToken,
    refreshToken,
    user: { userId, email: email.toLowerCase(), username, ...nameFields(nameInput.fields), role: 'admin' },
  }, 201);
});

// GET /v1/auth/invite/:token — whether an invite can still be used, and what
// the signup form can fill in: the email for an email invite, and for a
// wait-list invite (#363) the person's answers. A link invite has no email
// (`isLink: true`); a used, expired, or full one is 404, so the form can say
// so before anyone fills it in.
auth.get('/v1/auth/invite/:token', async (c) => {
  const invite = await db.getInvite(c.req.param('token'));
  // An invite for an existing account (forUserId) is accepted in the
  // classroom, never through signup.
  if (!invite || invite.status !== 'pending' || invite.forUserId
    || (invite.ttl && invite.ttl < Math.floor(Date.now() / 1000))) {
    return c.json({ error: 'Invalid or expired invite' }, 404);
  }
  if (!invite.email) {
    const full = invite.maxUsages != null && (invite.usageCount || 0) >= invite.maxUsages;
    if (!invite.isLink || full) return c.json({ error: 'Invalid or expired invite' }, 404);
    return c.json({ email: null, isLink: true, name: null, firstName: null, lastName: null, userGroup: null, customFields: {} });
  }
  const profile = invite.profile || {};
  const named = profile.firstName || profile.name;
  return c.json({
    email: invite.email,
    ...(named ? nameFields(profile) : { name: null, firstName: null, lastName: null }),
    userGroup: profile.userGroup || null,
    customFields: profile.customFields || {},
  });
});

// POST /v1/auth/signup — sign up with invite token
auth.post('/v1/auth/signup', async (c) => {
  const body = await c.req.json();
  const { inviteToken, password, username: rawUsername, userGroup, email: providedEmail, customFields: rawCustomFields } = body;

  if (!inviteToken || !password) {
    return c.json({ error: 'inviteToken, first name, and password are required' }, 400);
  }
  const nameInput = readNameInput(body, { required: true });
  if (nameInput.error) return c.json({ error: nameInput.error }, 400);
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }

  const invite = await db.getInvite(inviteToken);
  if (!invite || invite.status !== 'pending' || invite.forUserId) {
    return c.json({ error: 'Invalid or expired invite' }, 400);
  }

  // Check TTL hasn't passed (DynamoDB TTL deletion is async)
  if (invite.ttl && invite.ttl < Math.floor(Date.now() / 1000)) {
    return c.json({ error: 'Invalid or expired invite' }, 400);
  }

  // Determine the email based on invite type
  let userEmail;
  if (invite.email) {
    // Email-specific invite: email must match if provided (for backwards compat, providedEmail is optional)
    if (providedEmail && providedEmail.toLowerCase() !== invite.email.toLowerCase()) {
      return c.json({ error: 'This invite is for a different email address' }, 400);
    }
    userEmail = invite.email;
  } else if (invite.isLink) {
    // Link invite: any email allowed, but email is required
    if (!providedEmail) {
      return c.json({ error: 'Email is required' }, 400);
    }
    userEmail = providedEmail.toLowerCase();
    // NOTE: Usage limit check is done atomically in incrementLinkUsage() to prevent race conditions.
    // The check-then-increment here would allow concurrent signups to exceed the limit.
  } else {
    return c.json({ error: 'Invalid invite type' }, 400);
  }

  const existing = await db.getUserByEmail(userEmail);
  if (existing) {
    return c.json({ error: 'Account already exists for this email' }, 409);
  }

  const username = rawUsername ? rawUsername.toLowerCase() : generateUsername();
  if (rawUsername) {
    const usernameErr = validateUsername(rawUsername);
    if (usernameErr) return c.json({ error: usernameErr }, 400);
    const existingUsername = await db.getUserByUsername(rawUsername);
    if (existingUsername) return c.json({ error: 'Username already taken' }, 409);
  }

  // Custom user fields (#364): format-validated here, but required-ness is NOT
  // enforced at signup — a stale cached signup form shouldn't hard-fail. Any
  // missing required field is collected by ProfileCompletionGate on first visit.
  // A wait-list invite (#363) carries the person's answers; the form's values
  // win over them.
  const profile = invite.profile || null;
  let customFields = {};
  if (rawCustomFields !== undefined || profile?.customFields) {
    const settings = await db.getSyncData('_system', 'settings');
    const merged = mergeFieldValues(getFieldDefinitions(settings?.data), profile?.customFields || {}, rawCustomFields);
    if (merged.error) return c.json({ error: merged.error }, 400);
    customFields = merged.values;
  }

  // A wait-list group may have been renamed or deleted since the person joined.
  let profileGroup = null;
  if (profile?.userGroup) {
    const settings = await db.getSyncData('_system', 'settings');
    if ((settings?.data?.userGroups || []).includes(profile.userGroup)) profileGroup = profile.userGroup;
  }

  // For link invites, increment usage count BEFORE creating the user.
  // The atomic operation must gate account creation to prevent orphaned accounts
  // when the usage limit is reached during concurrent signups.
  if (invite.isLink) {
    try {
      await db.incrementLinkUsage(inviteToken);
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        // Usage limit reached - this is the authoritative check (atomic, race-free)
        return c.json({ error: 'This invite link has reached its usage limit' }, 400);
      }
      throw err;
    }
  }

  const userId = generateUserId();
  const passwordHash = await hashPassword(password);

  await db.createUser({
    userId,
    email: userEmail,
    username,
    passwordHash,
    ...nameInput.fields,
    // Only one of the classroom's groups: broadcasts target groups by name.
    userGroup: (userGroup && (await db.getSyncData('_system', 'settings'))?.data?.userGroups?.includes(userGroup) ? userGroup : null) || profileGroup || null,
    role: 'learner',
    slackUserId: invite.slackUserId || null,
    customFields,
  });

  await settleAdmissionGroupAssignment(userId);
  await pluginRegistry.emit('userCreated', { userId, email: userEmail, role: 'learner' });

  // Mark invite as used after successful user creation
  if (invite.isLink) {
    // Check if we should mark the invite as used (maxUsages reached)
    const updated = await db.getInvite(inviteToken);
    if (updated.maxUsages && updated.usageCount >= updated.maxUsages) {
      await db.markInviteUsed(inviteToken);
    }
  } else {
    // Email-specific invites are marked as used immediately
    await db.markInviteUsed(inviteToken);
  }

  const accessToken = await signAccessToken(userId, 'learner');
  const refreshToken = generateRefreshToken();
  await db.storeRefreshToken(hashToken(refreshToken), userId, hashToken(passwordHash));

  return c.json({
    accessToken,
    refreshToken,
    user: { userId, email: userEmail, username, ...nameFields(nameInput.fields), role: 'learner' },
  }, 201);
});

// POST /v1/auth/login
auth.post('/v1/auth/login', async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: 'Email/username and password are required' }, 400);
  }

  // If the identifier contains @, look up by email; otherwise by username
  const user = email.includes('@')
    ? await db.getUserByEmail(email)
    : await db.getUserByUsername(email);
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const accessToken = await signAccessToken(user.userId, user.role);
  const refreshToken = generateRefreshToken();
  await db.storeRefreshToken(hashToken(refreshToken), user.userId, hashToken(user.passwordHash));

  // Activity-tracking writes are best-effort: login must succeed even if
  // audit-log / user-record writes are throttled or unavailable. The login
  // itself is what users feel; missing activity data just degrades admin
  // stats for this user.
  try {
    await db.createAuditLog({
      action: 'user_login',
      userId: user.userId,
      email: user.email,
      performedBy: user.userId,
    });
  } catch { /* swallow */ }
  try {
    await db.setUserActivityField(user.userId, 'lastActiveAt', new Date().toISOString());
  } catch { /* swallow */ }

  return c.json({
    accessToken,
    refreshToken,
    user: { userId: user.userId, email: user.email, username: user.username, ...nameFields(user), role: normalizeRole(user.role) },
  });
});

// POST /v1/auth/refresh
auth.post('/v1/auth/refresh', async (c) => {
  const { refreshToken } = await c.req.json();
  if (!refreshToken) {
    return c.json({ error: 'refreshToken is required' }, 400);
  }

  const tokenHash = hashToken(refreshToken);
  // Read the user before consuming so a legacy token cannot straddle reset:
  // revocation either removes it first, or its replacement keeps the previous
  // credential version. DynamoDB must read the current password authoritatively.
  const candidate = await db.getRefreshToken(tokenHash);
  if (!candidate) return c.json({ error: 'Invalid refresh token' }, 401);
  const user = await db.getUserById(candidate.userId, { consistentRead: true });
  if (!user) {
    await db.deleteRefreshToken(tokenHash);
    return c.json({ error: 'User not found' }, 401);
  }
  // Atomic consume: only the request that deletes the row may rotate it, so
  // two concurrent refreshes with the same token can't both succeed (SEC-3).
  const stored = await db.consumeRefreshToken(tokenHash);
  if (!stored) {
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  const credentialVersion = hashToken(user.passwordHash || '');
  if (stored.userId !== user.userId || (stored.credentialVersion != null && stored.credentialVersion !== credentialVersion)) {
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Rotate: the old token is already consumed; issue the new one.
  const newRefreshToken = generateRefreshToken();
  const newTokenHash = hashToken(newRefreshToken);
  await db.storeRefreshToken(newTokenHash, user.userId, credentialVersion);
  const currentUser = await db.getUserById(user.userId, { consistentRead: true });
  if (!currentUser || hashToken(currentUser.passwordHash || '') !== credentialVersion) {
    await db.deleteRefreshToken(newTokenHash);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  const accessToken = await signAccessToken(user.userId, user.role);

  // Best-effort: a token refresh fires every ~15 min while a learner is
  // active, so this gives `lastActiveAt` a heartbeat without per-message
  // write amplification on the user record.
  try {
    await db.setUserActivityField(user.userId, 'lastActiveAt', new Date().toISOString());
  } catch { /* swallow */ }

  return c.json({ accessToken, refreshToken: newRefreshToken });
});

// POST /v1/auth/logout
auth.post('/v1/auth/logout', async (c) => {
  const { refreshToken } = await c.req.json();
  if (refreshToken) {
    await db.deleteRefreshToken(hashToken(refreshToken));
  }
  return c.json({ ok: true });
});

// POST /v1/auth/forgot-password
auth.post('/v1/auth/forgot-password', async (c) => {
  const { email } = await c.req.json();
  if (!email) {
    return c.json({ error: 'Email is required' }, 400);
  }

  // With email off there is no delivery channel: create no token, and answer
  // identically whether or not the account exists (no enumeration, EML-2).
  if (!emailDeliveryEnabled()) {
    return c.json({ ok: true, emailDelivery: 'off' });
  }

  let stage = 'lookup';
  try {
    const user = await db.getUserByEmail(email);
    if (user) {
      stage = 'token';
      const token = generateResetToken();
      await db.storeResetToken(hashToken(token), user.userId);
      stage = 'email';
      await sendResetEmail(user.email, token);
    }
  } catch {
    // Provider/database failures must not turn a known address into a distinct
    // public response. Exception text can contain addresses and reset links.
    logger.warn('password_reset_request_failed', { stage });
  }
  return c.json({ ok: true });
});

// POST /v1/auth/reset-password
auth.post('/v1/auth/reset-password', async (c) => {
  const { resetToken, password } = await c.req.json();
  if (!resetToken || !password) {
    return c.json({ error: 'resetToken and password are required' }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }

  const tokenHash = hashToken(resetToken);
  // Atomic consume makes the reset link single-use (SEC-3).
  const stored = await db.consumeResetToken(tokenHash);
  if (!stored) {
    return c.json({ error: 'Invalid or expired reset link' }, 400);
  }

  const user = await db.getUserById(stored.userId);
  if (!user) {
    return c.json({ error: 'User not found' }, 400);
  }

  const passwordHash = await hashPassword(password);
  await db.updateUser(user.userId, { passwordHash });
  // A password reset revokes every existing session for the account (SEC-3).
  await db.revokeUserTokens(user.userId);

  return c.json({ ok: true });
});


export default auth;
export { validateUsername, generateUsername };
