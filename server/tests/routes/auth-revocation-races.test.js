import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { default: auth } = await import('../../src/routes/auth.js');
const { default: db } = await import('../../src/lib/db.js');
const { hashToken } = await import('../../src/lib/crypto.js');
const { hashPassword } = await import('../../src/lib/password.js');

const app = new Hono();
app.route('/', auth);
const request = (path, body) => app.request(`/v1/auth/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const userId = `usr_${randomUUID()}`;
  const email = `${userId}@example.test`;
  const passwordHash = await hashPassword('old-password');
  await db.createUser({ userId, email, passwordHash, name: 'Race fixture', role: 'user' });
  await db.storeRefreshToken(hashToken(userId), userId);
  await db.storeResetToken(hashToken(`reset-${userId}`), userId);
  return { userId, email, passwordHash };
}

afterEach(() => mock.restoreAll());

describe('password reset orders refresh-session issuance', () => {
  it('rejects a refresh whose replacement is stored after reset completes', async () => {
    const { userId } = await fixture();
    const paused = barrier();
    const release = barrier();
    const original = db.storeRefreshToken.bind(db);
    let replacementHash;
    mock.method(db, 'storeRefreshToken', async (...args) => {
      replacementHash = args[0];
      paused.resolve();
      await release.promise;
      return original(...args);
    });
    const pending = request('refresh', { refreshToken: userId });
    await paused.promise;
    const reset = await request('reset-password', { resetToken: `reset-${userId}`, password: 'new-password' });
    release.resolve();
    assert.equal(reset.status, 200);
    assert.equal((await pending).status, 401);
    assert.equal(await db.getRefreshToken(replacementHash), null);
  });

  it('cannot rotate a legacy token when reset completes during the user lookup', async () => {
    const { userId } = await fixture();
    const paused = barrier();
    const release = barrier();
    const original = db.getUserById.bind(db);
    let first = true;
    mock.method(db, 'getUserById', async (...args) => {
      const user = await original(...args);
      if (first) {
        first = false;
        paused.resolve();
        await release.promise;
      }
      return user;
    });
    const pending = request('refresh', { refreshToken: userId });
    await paused.promise;
    const reset = await request('reset-password', { resetToken: `reset-${userId}`, password: 'new-password' });
    release.resolve();
    assert.equal(reset.status, 200);
    assert.equal((await pending).status, 401);
  });

  it('rejects a token bound to the credential from before a password change', async () => {
    const { userId, passwordHash } = await fixture();
    await db.storeRefreshToken(hashToken('credential-bound'), userId, hashToken(passwordHash));
    await db.updateUser(userId, { passwordHash: await hashPassword('new-password') });
    const response = await request('refresh', { refreshToken: 'credential-bound' });
    assert.equal(response.status, 401);
  });

  it('an old-password login in flight cannot retain a continuing session after reset', async () => {
    const { userId, email } = await fixture();
    const paused = barrier();
    const release = barrier();
    const original = db.storeRefreshToken.bind(db);
    mock.method(db, 'storeRefreshToken', async (...args) => {
      paused.resolve();
      await release.promise;
      return original(...args);
    });
    const pending = request('login', { email, password: 'old-password' });
    await paused.promise;
    const reset = await request('reset-password', { resetToken: `reset-${userId}`, password: 'new-password' });
    release.resolve();
    assert.equal(reset.status, 200);
    const login = await pending;
    assert.equal(login.status, 200);
    const { refreshToken } = await login.json();
    const refreshed = await request('refresh', { refreshToken });
    assert.equal(refreshed.status, 401);
  });
});
