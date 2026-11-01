import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import auth, { setFirebaseTokenVerifier } from '../../src/routes/auth.js';
import db from '../../src/lib/db.js';

function req(app, method, path, body) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('POST /v1/auth/signup', () => {
  beforeEach(() => {
    db.getInvite = async () => ({
      inviteToken: 'inv_test',
      email: 'test@example.com',
      status: 'pending',
      ttl: Math.floor(Date.now() / 1000) + 86400,
    });
    db.getUserByEmail = async () => null;
    db.getUserByUsername = async () => null;
    db.createUser = async () => {};
    db.markInviteUsed = async () => {};
    db.storeRefreshToken = async () => {};
  });

  it('creates user with valid invite', async () => {
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/signup', {
      inviteToken: 'inv_test', name: 'Test', password: 'password123',
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.accessToken);
    assert.ok(data.refreshToken);
    assert.equal(data.user.email, 'test@example.com');
    assert.equal(data.user.role, 'user');
    assert.ok(data.user.username); // auto-generated when not provided
  });

  it('creates user with custom username', async () => {
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/signup', {
      inviteToken: 'inv_test', name: 'Test', password: 'password123', username: 'testuser',
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.user.username, 'testuser');
  });

  it('rejects invalid username format', async () => {
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/signup', {
      inviteToken: 'inv_test', name: 'Test', password: 'password123', username: '-bad',
    });
    assert.equal(res.status, 400);
  });

  it('rejects expired invite', async () => {
    db.getInvite = async () => ({
      inviteToken: 'inv_test', email: 'test@example.com', status: 'pending',
      ttl: Math.floor(Date.now() / 1000) - 1000,
    });
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/signup', {
      inviteToken: 'inv_test', name: 'Test', password: 'password123',
    });
    assert.equal(res.status, 400);
  });

  it('rejects short password', async () => {
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/signup', {
      inviteToken: 'inv_test', name: 'Test', password: 'short',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('8 characters'));
  });

  it('rejects used invite', async () => {
    db.getInvite = async () => ({ inviteToken: 'inv_test', email: 'test@example.com', status: 'used' });
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/signup', {
      inviteToken: 'inv_test', name: 'Test', password: 'password123',
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /v1/auth/signup — custom user fields (#364)', () => {
  const FIELDS = [
    { id: 'fld_org', label: 'Organization', type: 'text', required: true },
    { id: 'fld_site', label: 'Website', type: 'link', required: false },
  ];
  let created;

  beforeEach(() => {
    created = null;
    db.getInvite = async () => ({
      inviteToken: 'inv_test', email: 'test@example.com', status: 'pending',
      ttl: Math.floor(Date.now() / 1000) + 86400,
    });
    db.getUserByEmail = async () => null;
    db.getUserByUsername = async () => null;
    db.createUser = async (u) => { created = u; };
    db.markInviteUsed = async () => {};
    db.storeRefreshToken = async () => {};
    db.getSyncData = async () => ({ data: { userFields: FIELDS } });
  });

  it('stores validated custom field values on the new user', async () => {
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/signup', {
      inviteToken: 'inv_test', name: 'Test', password: 'password123',
      customFields: { fld_org: 'UIC', fld_unknown: 'dropped' },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(created.customFields, { fld_org: 'UIC' });
  });

  it('does not enforce required fields at signup (the gate collects them)', async () => {
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/signup', {
      inviteToken: 'inv_test', name: 'Test', password: 'password123',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(created.customFields, {});
  });

  it('rejects malformed values', async () => {
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/signup', {
      inviteToken: 'inv_test', name: 'Test', password: 'password123',
      customFields: { fld_site: 'ftp://nope' },
    });
    assert.equal(res.status, 400);
    assert.equal(created, null);
  });
});

describe('POST /v1/auth/login', () => {
  beforeEach(() => {
    db.storeRefreshToken = async () => {};
    db.getUserByUsername = async () => null;
    db.createAuditLog = async () => {};
    db.setUserActivityField = async () => {};
  });

  it('logs in with correct credentials', async () => {
    const { hashPassword } = await import('../../src/lib/password.js');
    const hash = await hashPassword('password123');
    db.getUserByEmail = async () => ({
      userId: 'usr_test', email: 'test@example.com', username: 'testuser', name: 'Test',
      role: 'user', passwordHash: hash,
    });
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/login', { email: 'test@example.com', password: 'password123' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.accessToken);
    assert.ok(data.refreshToken);
    assert.equal(data.user.username, 'testuser');
  });

  it('login updates lastActiveAt on the user record', async () => {
    const { hashPassword } = await import('../../src/lib/password.js');
    const hash = await hashPassword('password123');
    db.getUserByEmail = async () => ({
      userId: 'usr_test', email: 'test@example.com', username: 'testuser', name: 'Test',
      role: 'user', passwordHash: hash,
    });
    const writes = [];
    db.setUserActivityField = async (userId, field, value) => { writes.push({ userId, field, value }); };
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/login', { email: 'test@example.com', password: 'password123' });
    assert.equal(res.status, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].field, 'lastActiveAt');
    assert.ok(new Date(writes[0].value).getTime() > 0);
  });

  it('login still succeeds when the lastActiveAt write throws', async () => {
    const { hashPassword } = await import('../../src/lib/password.js');
    const hash = await hashPassword('password123');
    db.getUserByEmail = async () => ({
      userId: 'usr_test', email: 'test@example.com', username: 'testuser', name: 'Test',
      role: 'user', passwordHash: hash,
    });
    db.setUserActivityField = async () => { throw new Error('throttled'); };
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/login', { email: 'test@example.com', password: 'password123' });
    assert.equal(res.status, 200, 'login must not fail if lastActiveAt write fails');
  });

  it('login still succeeds when the audit-log write throws', async () => {
    const { hashPassword } = await import('../../src/lib/password.js');
    const hash = await hashPassword('password123');
    db.getUserByEmail = async () => ({
      userId: 'usr_test', email: 'test@example.com', username: 'testuser', name: 'Test',
      role: 'user', passwordHash: hash,
    });
    db.createAuditLog = async () => { throw new Error('audit-log throttled'); };
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/login', { email: 'test@example.com', password: 'password123' });
    assert.equal(res.status, 200, 'login must not fail if audit-log write fails');
    const data = await res.json();
    assert.ok(data.accessToken);
    assert.ok(data.refreshToken);
  });

  it('logs in with username', async () => {
    const { hashPassword } = await import('../../src/lib/password.js');
    const hash = await hashPassword('password123');
    db.getUserByEmail = async () => null;
    db.getUserByUsername = async () => ({
      userId: 'usr_test', email: 'test@example.com', username: 'testuser', name: 'Test',
      role: 'user', passwordHash: hash,
    });
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/login', { email: 'testuser', password: 'password123' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user.username, 'testuser');
  });

  it('rejects wrong password', async () => {
    const { hashPassword } = await import('../../src/lib/password.js');
    const hash = await hashPassword('correctpass');
    db.getUserByEmail = async () => ({
      userId: 'usr_test', email: 'test@example.com', name: 'Test',
      role: 'user', passwordHash: hash,
    });
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/login', { email: 'test@example.com', password: 'wrongpassword' });
    assert.equal(res.status, 401);
  });

  it('rejects unknown email', async () => {
    db.getUserByEmail = async () => null;
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/login', { email: 'nobody@example.com', password: 'password123' });
    assert.equal(res.status, 401);
  });
});

describe('POST /v1/auth/refresh', () => {
  beforeEach(() => {
    db.getRefreshToken = async () => ({ tokenHash: 'hash', userId: 'usr_test' });
  });
  it('rotates refresh tokens', async () => {
    db.consumeRefreshToken = async () => ({ tokenHash: 'hash', userId: 'usr_test' });
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
    db.deleteRefreshToken = async () => {};
    db.storeRefreshToken = async () => {};
    db.setUserActivityField = async () => {};
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/refresh', { refreshToken: 'rt_test' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.accessToken);
    assert.ok(data.refreshToken);
  });

  it('refresh updates lastActiveAt (heartbeat without per-message amplification)', async () => {
    db.consumeRefreshToken = async () => ({ tokenHash: 'hash', userId: 'usr_test' });
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
    db.deleteRefreshToken = async () => {};
    db.storeRefreshToken = async () => {};
    const writes = [];
    db.setUserActivityField = async (userId, field, value) => { writes.push({ userId, field, value }); };
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/refresh', { refreshToken: 'rt_test' });
    assert.equal(res.status, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].field, 'lastActiveAt');
  });

  it('refresh succeeds even if lastActiveAt write throws', async () => {
    db.consumeRefreshToken = async () => ({ tokenHash: 'hash', userId: 'usr_test' });
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
    db.deleteRefreshToken = async () => {};
    db.storeRefreshToken = async () => {};
    db.setUserActivityField = async () => { throw new Error('throttled'); };
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/refresh', { refreshToken: 'rt_test' });
    assert.equal(res.status, 200, 'refresh must not fail if lastActiveAt write fails');
  });

  it('rejects invalid refresh token', async () => {
    db.consumeRefreshToken = async () => null;
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/refresh', { refreshToken: 'rt_invalid' });
    assert.equal(res.status, 401);
  });
});

describe('POST /v1/auth/reset-password (SEC-2, SEC-3)', () => {
  it('rejects a reset token presented to /refresh', async () => {
    db.consumeRefreshToken = async () => null;
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/refresh', { refreshToken: 'reset_token_value' });
    assert.equal(res.status, 401);
  });

  it('revokes sessions on reset and the reset link is single-use', async () => {
    let resetAvailable = true;
    let revokedFor = null;
    db.consumeResetToken = async () => {
      if (!resetAvailable) return null;
      resetAvailable = false;
      return { userId: 'usr_test' };
    };
    db.consumeRefreshToken = async () => (revokedFor ? null : { userId: 'usr_test' });
    db.getUserById = async () => ({ userId: 'usr_test', role: 'user' });
    db.updateUser = async () => {};
    db.revokeUserTokens = async (userId) => { revokedFor = userId; };
    db.storeRefreshToken = async () => {};
    db.setUserActivityField = async () => {};
    const app = new Hono();
    app.route('/', auth);

    const first = await req(app, 'POST', '/v1/auth/reset-password', { resetToken: 'rst', password: 'newpassword1' });
    assert.equal(first.status, 200);
    assert.equal(revokedFor, 'usr_test');

    const second = await req(app, 'POST', '/v1/auth/reset-password', { resetToken: 'rst', password: 'newpassword1' });
    assert.equal(second.status, 400);

    const refresh = await req(app, 'POST', '/v1/auth/refresh', { refreshToken: 'old_rt' });
    assert.equal(refresh.status, 401);
  });
});

describe('POST /v1/auth/forgot-password (EML-2)', () => {
  beforeEach(() => {
    process.env.SKIP_EMAIL = 'true';
  });

  afterEach(() => {
    delete process.env.SKIP_EMAIL;
  });

  it('answers identically for existing and unknown emails, storing no token', async () => {
    let stored = false;
    db.storeResetToken = async () => { stored = true; };
    db.getUserByEmail = async (email) => (email === 'known@example.com' ? { userId: 'usr_test', email } : null);
    const app = new Hono();
    app.route('/', auth);
    const known = await req(app, 'POST', '/v1/auth/forgot-password', { email: 'known@example.com' });
    const unknown = await req(app, 'POST', '/v1/auth/forgot-password', { email: 'ghost@example.com' });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), { ok: true, emailDelivery: 'off' });
    assert.deepEqual(await unknown.json(), { ok: true, emailDelivery: 'off' });
    assert.equal(stored, false);
  });
});

describe('POST /v1/auth/logout', () => {
  it('deletes refresh token', async () => {
    let deleted = false;
    db.deleteRefreshToken = async () => { deleted = true; };
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/logout', { refreshToken: 'rt_test' });
    assert.equal(res.status, 200);
    assert.ok(deleted);
  });
});

describe('POST /v1/auth/firebase', () => {
  let createdUsers = [];

  beforeEach(() => {
    createdUsers = [];
    db.countUsers = async () => 1; // existing classroom setup
    db.getUserByEmail = async () => null;
    db.getUserByUsername = async () => null;
    db.getInvite = async () => null;
    db.getInviteByEmail = async () => null;
    db.getWaitlistEntryByEmail = async () => null;
    db.createUser = async (u) => { createdUsers.push(u); };
    db.storeRefreshToken = async () => {};
    db.createAuditLog = async () => {};
    db.setUserActivityField = async () => {};
    db.getSyncData = async () => null;
    setFirebaseTokenVerifier(null);
  });

  it('rejects request with missing idToken', async () => {
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/firebase', {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'Firebase ID token is required');
  });

  it('rejects invalid or expired idToken', async () => {
    setFirebaseTokenVerifier(async () => { throw new Error('JWT verification failed'); });
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/firebase', { idToken: 'invalid_token' });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, 'Invalid or expired Google sign-in token');
  });

  it('rejects unverified Google email', async () => {
    setFirebaseTokenVerifier(async () => ({ email: 'unverified@example.com', email_verified: false }));
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/firebase', { idToken: 'test_token' });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'A verified Google email address is required');
  });

  it('logs in existing user matching verified Google email', async () => {
    setFirebaseTokenVerifier(async () => ({ email: 'existing@example.com', email_verified: true, name: 'Existing User' }));
    db.getUserByEmail = async (email) => {
      if (email === 'existing@example.com') {
        return { userId: 'usr_existing', email, username: 'existinguser', name: 'Existing User', role: 'user' };
      }
      return null;
    };
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/firebase', { idToken: 'valid_token' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.accessToken);
    assert.ok(data.refreshToken);
    assert.equal(data.user.email, 'existing@example.com');
    assert.equal(data.user.userId, 'usr_existing');
  });

  it('refuses a new verified Google user without an invitation', async () => {
    setFirebaseTokenVerifier(async () => ({
      email: 'newlearner@example.com',
      email_verified: true,
      name: 'New Learner',
    }));
    let storedTokens = 0;
    db.storeRefreshToken = async () => { storedTokens += 1; };
    const app = new Hono();
    app.route('/', auth);
    const res = await req(app, 'POST', '/v1/auth/firebase', { idToken: 'valid_token' });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.code, 'invite_required');
    assert.equal(data.email, 'newlearner@example.com');
    assert.equal(data.accessToken, undefined);
    assert.equal(createdUsers.length, 0);
    assert.equal(storedTokens, 0);
  });
});

describe('first-admin setup classroom name', () => {
  let createdUsers;
  let records;

  beforeEach(() => {
    createdUsers = [];
    records = new Map();
    db.countUsers = async () => 0;
    db.getUserByEmail = async () => null;
    db.getUserByUsername = async () => null;
    db.createUser = async (u) => { createdUsers.push(u); };
    db.storeRefreshToken = async () => {};
    db.getSyncData = async (userId, key) => records.get(`${userId}:${key}`) || null;
    db.putSyncData = async (userId, key, data, version) => {
      records.set(`${userId}:${key}`, { data, version: (version || 0) + 1 });
      return { version: (version || 0) + 1 };
    };
    setFirebaseTokenVerifier(async () => ({ email: 'owner@example.com', email_verified: true, name: 'Owner' }));
  });

  const setups = [
    ['/v1/auth/setup', name => ({ email: 'owner@example.com', name: 'Owner', password: 'password123', classroomName: name })],
    ['/v1/auth/firebase', name => ({ idToken: 'valid_token', classroomName: name })],
  ];

  for (const [path, body] of setups) {
    it(`${path} rejects a name the Customizer would reject, before creating the admin`, async () => {
      const app = new Hono();
      app.route('/', auth);
      for (const name of [42, { text: 'x' }, null, 'x'.repeat(101), 'Line\nbreak']) {
        const res = await req(app, 'POST', path, body(name));
        assert.equal(res.status, 400, `accepted ${JSON.stringify(name)}`);
        assert.match((await res.json()).error, /Classroom name/);
      }
      assert.equal(createdUsers.length, 0);
    });

    it(`${path} stores a trimmed name with the primary-matching default theme`, async () => {
      const app = new Hono();
      app.route('/', auth);
      const res = await req(app, 'POST', path, body(`  ${'é'.repeat(100)}  `));
      assert.equal(res.status, 201);
      const settings = records.get('_system:settings').data;
      assert.equal(settings.classroomName, 'é'.repeat(100));
      assert.deepEqual(settings.theme, { primary: '#8b1a1a' });
    });
  }
});
