// Sign-in protection: per-address flood guards (upstream #517/#520) and the
// fork's fixed lockout (lib/sign-in-guard.js): delays grow, they fall on the
// requester rather than the account, and parallel guesses can't slip through.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import auth, { _resetAuthLimits } from '../../src/routes/auth.js';
import db from '../../src/lib/db.js';
import { hashPassword } from '../../src/lib/password.js';
import { verifyDeviceToken } from '../../src/lib/sign-in-guard.js';

const PASSWORD = 'right-password';
const passwordHash = await hashPassword(PASSWORD);
const learner = { userId: 'usr_learner', email: 'learner@example.com', username: 'learner', role: 'learner', passwordHash };

const app = new Hono();
app.route('/', auth);
const post = (path, body, ip = '203.0.113.7') => app.request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const login = (password, { ip, deviceToken, email = learner.email } = {}) => post('/v1/auth/login', { email, password, deviceToken }, ip);

beforeEach(() => {
  _resetAuthLimits();
  db.getUserByEmail = async (email) => (email.toLowerCase() === learner.email ? learner : null);
  db.getUserByUsername = async (name) => (name.toLowerCase() === learner.username ? learner : null);
  db.storeRefreshToken = async () => {};
  db.createAuditLog = async () => {};
  db.setUserActivityField = async () => {};
  db.countUsers = async () => 1;
});

describe('sign-in protection', () => {
  it('answers 400 to malformed JSON on every public auth endpoint', async () => {
    db.countUsers = async () => 0; // so setup reads its body
    for (const path of ['/v1/auth/login', '/v1/auth/refresh', '/v1/auth/logout', '/v1/auth/forgot-password', '/v1/auth/reset-password', '/v1/auth/signup', '/v1/auth/setup']) {
      const res = await post(path, '{not json');
      assert.equal(res.status, 400, path);
      assert.deepEqual(await res.json(), { error: 'Invalid JSON' }, path);
    }
  });

  it('returns a device token for this account with every sign-in', async () => {
    const res = await login(PASSWORD);
    assert.equal(res.status, 200);
    const { deviceToken } = await res.json();
    assert.ok(verifyDeviceToken(deviceToken, learner.userId));
  });

  it('delays the fifth wrong password by 30 s, and does not check passwords while delayed', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await login(`wrong-${i}`)).status);
    assert.deepEqual(statuses, [401, 401, 401, 401]);
    const fifth = await login('wrong-5');
    assert.equal(fifth.status, 429);
    assert.equal(fifth.headers.get('Retry-After'), '30');
    assert.deepEqual(await fifth.json(), { error: 'Too many sign-in attempts. Try again in 30 seconds.', code: 'sign_in_delayed', retryAfterMs: 30_000 });
    const right = await login(PASSWORD);
    assert.equal(right.status, 429, 'not even the right password is checked while delayed');
  });

  it('does not delay the same account from another address', async () => {
    for (let i = 0; i < 6; i++) await login(`wrong-${i}`, { ip: '198.51.100.9' });
    assert.equal((await login(PASSWORD)).status, 200);
  });

  it('never delays a device that has signed in before because of someone else’s guesses', async () => {
    const { deviceToken } = await (await login(PASSWORD)).json();
    for (let i = 0; i < 8; i++) await login(`wrong-${i}`); // same address, no device token
    assert.equal((await login(PASSWORD)).status, 429, 'an untrusted attempt from that address waits');
    const res = await login(PASSWORD, { deviceToken });
    assert.equal(res.status, 200, 'the learner’s own device signs in');
    const next = (await res.json()).deviceToken;
    assert.equal(next.split('.')[0], deviceToken.split('.')[0], 'the same device keeps its id');
  });

  it('a right password starts the count over', async () => {
    for (let i = 0; i < 4; i++) await login(`wrong-${i}`);
    assert.equal((await login(PASSWORD)).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await login(`wrong-again-${i}`)).status, 401);
  });

  it('counts guesses sent in parallel: at most five are checked', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login(`parallel-${i}`)));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 4);
    assert.equal(statuses.filter((s) => s === 429).length, 8);
  });

  it('treats unknown names the same way', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await login('whatever', { email: 'nobody@example.com' })).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
  });

  it('accepts a username as the identifier', async () => {
    assert.equal((await login(PASSWORD, { email: 'learner' })).status, 200);
  });

  it('limits one address flooding an endpoint (setup: 10 per 10 minutes)', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post('/v1/auth/setup', { email: 'a@example.com', password: 'password123', firstName: 'A' })).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400), 'setup is already done');
    assert.equal(statuses[10], 429);
  });

  it('turns the per-address limits off rather than sharing one bucket when no public address is known', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await post('/v1/auth/setup', { email: 'a@example.com', password: 'password123', firstName: 'A' }, '169.254.169.126')).status);
    assert.ok(statuses.every((s) => s === 400));
  });
});
