/**
 * Google sign-in admission: membership is by invitation. A new Google account
 * needs an invite link or a pending email invite; the operator's ADMIN_EMAIL
 * is the only exception and the only address made an admin. Without an
 * invitation nothing is created or consumed, and the verified owner learns
 * where they stand.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// config.js reads ADMIN_EMAIL at import time; node --test runs each file in
// its own process, so this stays local to this file. Mixed case on purpose.
process.env.ADMIN_EMAIL = 'Operator@Example.test';
const { default: plugin, setFirebaseTokenVerifier } = await import('./index.js');
const { default: db } = await import('../../../server/src/lib/db.js');
const { verifyAccessToken } = await import('../../../server/src/lib/jwt.js');
const { on: onHook } = await import('../../../server/src/lib/plugins/hooks.js');

const future = () => Math.floor(Date.now() / 1000) + 86400;
const past = () => Math.floor(Date.now() / 1000) - 60;

let calls;
let app;

function signInAs(claims) {
  setFirebaseTokenVerifier(async () => ({
    sub: 'google-subject',
    email_verified: true,
    firebase: { sign_in_provider: 'google.com' },
    ...claims,
  }));
}

function post(body = { idToken: 'valid_token' }) {
  return app.request('/v1/plugins/google-auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  calls = { created: [], used: [], deleted: [], linkUses: [], tokens: 0 };
  app = new Hono();
  app.route('/v1/plugins/google-auth', plugin.routes);
  db.countUsers = async () => 1;
  db.getUserByEmail = async () => null;
  db.getUserByUsername = async () => null;
  db.getInvite = async () => null;
  db.getInviteByEmail = async () => null;
  db.getWaitlistEntryByEmail = async () => null;
  db.getSyncData = async () => null;
  db.createUser = async (user) => { calls.created.push(user); };
  db.markInviteUsed = async (token) => { calls.used.push(token); };
  db.deleteInvite = async (token) => { calls.deleted.push(token); };
  db.incrementLinkUsage = async (token) => { calls.linkUses.push(token); };
  db.storeRefreshToken = async () => { calls.tokens += 1; };
  db.createAuditLog = async () => {};
  db.setUserActivityField = async () => {};
});

describe('Google sign-in without an invitation', () => {
  it('creates nothing and tells the verified owner that membership is by invitation', async () => {
    signInAs({ email: 'New.Learner@Example.com', name: ' New Learner ' });
    const res = await post();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      error: 'Membership is by invitation only. Ask your program admin for an invitation.',
      code: 'invite_required',
      email: 'new.learner@example.com',
      name: 'New Learner',
      waitlisted: false,
      inviteExpired: false,
    });
    assert.deepEqual(calls, { created: [], used: [], deleted: [], linkUses: [], tokens: 0 });
  });

  it('keeps a wait-list entry for an admin to invite, and says the person is on the list', async () => {
    signInAs({ email: 'waiting@example.com', name: 'Waiting Person' });
    db.getWaitlistEntryByEmail = async (email) => (email === 'waiting@example.com'
      ? { inviteToken: 'inv_waitlist', email, status: 'waitlist', profile: { name: 'Waiting Person' } }
      : null);
    const res = await post();
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.code, 'invite_required');
    assert.equal(data.waitlisted, true);
    assert.deepEqual(calls.deleted, [], 'the wait-list entry is not consumed');
    assert.deepEqual(calls.created, []);
  });

  it('reports an expired emailed invitation', async () => {
    signInAs({ email: 'late@example.com' });
    db.getInviteByEmail = async () => ({ inviteToken: 'inv_late', email: 'late@example.com', status: 'pending', ttl: past() });
    const res = await post();
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.inviteExpired, true);
    assert.equal(data.name, '', 'no Google name means no prefill, not the email prefix');
    assert.deepEqual(calls.used, []);
    assert.deepEqual(calls.created, []);
  });
});

describe('Google sign-in with an invitation', () => {
  it('creates a learner from a pending emailed invitation and uses it up', async () => {
    signInAs({ email: 'invited@example.com', name: 'Invited Learner' });
    db.getInviteByEmail = async () => ({ inviteToken: 'inv_email', email: 'invited@example.com', status: 'pending', ttl: future() });
    const res = await post();
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.user.email, 'invited@example.com');
    assert.equal(data.user.role, 'learner');
    assert.equal(calls.created.length, 1);
    assert.deepEqual(calls.used, ['inv_email']);
  });

  it('creates a learner from an invite link', async () => {
    signInAs({ email: 'linked@example.com', name: 'Linked Learner' });
    db.getInvite = async (token) => (token === 'inv_link'
      ? { inviteToken: 'inv_link', email: null, isLink: true, status: 'pending', ttl: future(), usageCount: 0, maxUsages: null }
      : null);
    const res = await post({ idToken: 'valid_token', inviteToken: 'inv_link' });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).user.role, 'learner');
    assert.deepEqual(calls.linkUses, ['inv_link']);
  });

  it('never makes an invited person an admin', async () => {
    signInAs({ email: 'someone@example.com' });
    db.getInviteByEmail = async () => ({ inviteToken: 'inv_someone', email: 'someone@example.com', status: 'pending', ttl: future() });
    const res = await post();
    assert.equal(res.status, 201);
    assert.equal(calls.created[0].role, 'learner');
  });

  it('rejects an existing-account invite supplied as a public signup token', async () => {
    signInAs({ email: 'existing-invite@example.com' });
    db.getInvite = async token => token === 'inv_existing'
      ? { inviteToken: token, email: 'existing-invite@example.com', status: 'pending', ttl: future(), forUserId: 'usr_existing' }
      : null;
    const res = await post({ idToken: 'valid_token', inviteToken: 'inv_existing' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid or expired invite' });
    assert.deepEqual(calls, { created: [], used: [], deleted: [], linkUses: [], tokens: 0 });
  });

  it('does not adopt an existing-account invite found by email', async () => {
    signInAs({ email: 'existing-invite@example.com' });
    db.getInviteByEmail = async () => ({
      inviteToken: 'inv_existing', email: 'existing-invite@example.com', status: 'pending', ttl: future(), forUserId: 'usr_existing',
    });
    const res = await post();
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'invite_required');
    assert.equal(body.inviteExpired, false);
    assert.deepEqual(calls, { created: [], used: [], deleted: [], linkUses: [], tokens: 0 });
  });

  it('emits the core userCreated hook used by Slack after persisting the account', async () => {
    signInAs({ email: 'slack-linked@example.com' });
    db.getInviteByEmail = async () => ({
      inviteToken: 'inv_slack', email: 'slack-linked@example.com', status: 'pending', ttl: future(), slackUserId: 'U123',
    });
    const seen = [];
    const unsubscribe = onHook('userCreated', payload => { seen.push(payload); });
    try {
      const res = await post();
      assert.equal(res.status, 201);
      assert.equal(calls.created[0].slackUserId, 'U123');
      assert.deepEqual(seen, [{ userId: calls.created[0].userId, email: 'slack-linked@example.com', role: 'learner' }]);
    } finally {
      unsubscribe();
    }
  });
});

describe('The operator address (ADMIN_EMAIL)', () => {
  it('can create its own account without an invitation, as an admin', async () => {
    signInAs({ email: 'operator@example.test', name: 'Operator' });
    const res = await post();
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.user.role, 'admin');
    assert.equal(calls.created[0].role, 'admin');
  });
});

describe('Existing accounts and first-time setup', () => {
  it('signs in an existing account without an invitation and keeps its role', async () => {
    let inviteLookups = 0;
    db.getInvite = async () => { inviteLookups += 1; return null; };
    db.getInviteByEmail = async () => { inviteLookups += 1; return null; };
    for (const role of ['admin', 'user']) {
      signInAs({ email: `existing.${role}@example.com` });
      db.getUserByEmail = async (email) => (email === `existing.${role}@example.com`
        ? { userId: `usr_${role}`, email, username: `existing${role}`, name: `Existing ${role}`, role, passwordHash: 'stored' }
        : null);
      const res = await post();
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.user.userId, `usr_${role}`);
      assert.equal(data.user.role, role === 'user' ? 'learner' : role);
      assert.equal((await verifyAccessToken(data.accessToken)).role, role === 'user' ? 'learner' : role);
    }
    assert.equal(inviteLookups, 0, 'an existing account never needs an invitation');
    assert.deepEqual(calls.created, []);
    assert.equal(calls.tokens, 2);
  });

  it('makes the first Google account on an empty database the admin, without an invitation', async () => {
    db.countUsers = async () => 0;
    db.putSyncData = async () => ({ version: 1 });
    signInAs({ email: 'founder@example.com', name: 'Founder' });
    const res = await post({ idToken: 'valid_token', classroomName: 'Founding Classroom' });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.isNewSetup, true);
    assert.equal(data.user.role, 'admin');
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].role, 'admin');
    assert.deepEqual(calls.used, []);
  });
});

it('preserves an explicitly entered Google name split on setup and invited signup', async () => {
  signInAs({ email: 'mary@example.test', name: 'Mary Ann Evans' });
  db.countUsers = async () => 0;
  db.putSyncData = async () => ({ version: 1 });
  const setup = await post({ idToken: 'valid_token', firstName: 'Mary Ann', lastName: 'Evans' });
  assert.equal(setup.status, 201);
  const setupBody = await setup.json();
  for (const user of [calls.created[0], setupBody.user]) {
    assert.deepEqual(
      [user.firstName, user.lastName, user.name, user.nameSource],
      ['Mary Ann', 'Evans', 'Mary Ann Evans', 'user'],
    );
  }
  db.countUsers = async () => 1;
  db.getInviteByEmail = async () => ({ inviteToken: 'inv_mary', email: 'mary@example.test', status: 'pending', ttl: future() });
  const signup = await post({ idToken: 'valid_token', firstName: 'Mary Ann', lastName: 'Evans' });
  assert.equal(signup.status, 201);
  const signupBody = await signup.json();
  for (const user of [calls.created[1], signupBody.user]) {
    assert.deepEqual(
      [user.firstName, user.lastName, user.name, user.nameSource],
      ['Mary Ann', 'Evans', 'Mary Ann Evans', 'user'],
    );
  }
  assert.equal((await verifyAccessToken(signupBody.accessToken)).role, 'learner');
});

describe('Firebase token validation', () => {
  it('requires an ID token and bounds its size', async () => {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ idToken: 'x'.repeat(16385) })).status, 413);
  });

  it('rejects invalid or expired tokens', async () => {
    setFirebaseTokenVerifier(async () => { throw new Error('JWT verification failed'); });
    const res = await post();
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'Invalid or expired Google sign-in token');
  });

  it('requires a verified email and the Google provider with a subject', async () => {
    signInAs({ email: 'unverified@example.com', email_verified: false });
    assert.equal((await post()).status, 400);

    signInAs({ email: 'wrong@example.com', firebase: { sign_in_provider: 'password' } });
    assert.equal((await post()).status, 401);

    signInAs({ email: 'missing@example.com', sub: '' });
    assert.equal((await post()).status, 401);
  });

  it('uses the plugin project ID for issuer and audience verification', async () => {
    let verifiedProject;
    setFirebaseTokenVerifier(async (_token, project) => {
      verifiedProject = project;
      return {
        sub: 'google-subject',
        email: 'existing@example.com',
        email_verified: true,
        firebase: { sign_in_provider: 'google.com' },
      };
    });
    db.getSyncData = async (_user, key) => key === 'plugins:activation'
      ? { data: { 'google-auth': { settings: { projectId: 'configured-project' } } } }
      : null;
    db.getUserByEmail = async email => ({ userId: 'usr_existing', email, username: 'existing', name: 'Existing', role: 'user', passwordHash: 'stored' });
    const res = await post();
    assert.equal(res.status, 200);
    assert.equal(verifiedProject, 'configured-project');
  });
});
