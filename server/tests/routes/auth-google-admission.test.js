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
const { default: auth, setFirebaseTokenVerifier } = await import('../../src/routes/auth.js');
const { default: db } = await import('../../src/lib/db.js');

const future = () => Math.floor(Date.now() / 1000) + 86400;
const past = () => Math.floor(Date.now() / 1000) - 60;

let calls;
let app;

function signInAs(claims) {
  setFirebaseTokenVerifier(async () => ({ email_verified: true, ...claims }));
}

function post(body = { idToken: 'valid_token' }) {
  return app.request('/v1/auth/firebase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  calls = { created: [], used: [], deleted: [], linkUses: [], tokens: 0 };
  app = new Hono();
  app.route('/', auth);
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
    assert.equal(data.user.role, 'user');
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
    assert.equal((await res.json()).user.role, 'user');
    assert.deepEqual(calls.linkUses, ['inv_link']);
  });

  it('never makes an invited person an admin', async () => {
    signInAs({ email: 'someone@example.com' });
    db.getInviteByEmail = async () => ({ inviteToken: 'inv_someone', email: 'someone@example.com', status: 'pending', ttl: future() });
    const res = await post();
    assert.equal(res.status, 201);
    assert.equal(calls.created[0].role, 'user');
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
