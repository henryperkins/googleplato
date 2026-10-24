import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { default: auth } = await import('../../src/routes/auth.js');
const { default: me } = await import('../../src/routes/me.js');
const { default: db } = await import('../../src/lib/db.js');
const { hashToken } = await import('../../src/lib/crypto.js');
const { hashPassword } = await import('../../src/lib/password.js');

const app = new Hono();
app.route('/', auth);
app.route('/', me);
const post = (path, body) => app.request(`/v1/auth/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const patchMe = (accessToken, body) => app.request('/v1/me', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify(body),
});
async function signedInTwice() {
  const userId = `usr_${randomUUID()}`;
  const email = `${userId}@example.test`;
  await db.createUser({ userId, email, passwordHash: await hashPassword('old-password'), name: 'Settings fixture', role: 'user' });
  const login = async () => (await post('login', { email, password: 'old-password' })).json();
  return { userId, thisDevice: await login(), otherDevice: await login() };
}

describe('changing the password in Settings', () => {
  it('keeps this device signed in and signs out every other session', async () => {
    const { thisDevice, otherDevice } = await signedInTwice();
    const res = await patchMe(thisDevice.accessToken, { password: 'new-password' });
    assert.equal(res.status, 200);
    const { session, passwordHash } = await res.json();
    assert.equal(passwordHash, undefined);
    assert.ok(session?.accessToken && session?.refreshToken);
    assert.equal((await post('refresh', { refreshToken: session.refreshToken })).status, 200);
    assert.equal((await post('refresh', { refreshToken: thisDevice.refreshToken })).status, 401);
    assert.equal((await post('refresh', { refreshToken: otherDevice.refreshToken })).status, 401);
  });

  it('revokes legacy refresh tokens that carry no credential fingerprint', async () => {
    const { userId, thisDevice } = await signedInTwice();
    await db.storeRefreshToken(hashToken('legacy-session'), userId);
    assert.equal((await patchMe(thisDevice.accessToken, { password: 'new-password' })).status, 200);
    assert.equal((await post('refresh', { refreshToken: 'legacy-session' })).status, 401);
  });

  it('leaves sessions alone when the password does not change', async () => {
    const { thisDevice, otherDevice } = await signedInTwice();
    const res = await patchMe(thisDevice.accessToken, { name: 'Renamed' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).session, undefined);
    assert.equal((await post('refresh', { refreshToken: otherDevice.refreshToken })).status, 200);
  });
});
