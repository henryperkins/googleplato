// The device token keeps this browser's failed sign-ins apart from everyone
// else's (server lib/sign-in-guard.js): sent with each sign-in, replaced by
// the one the server returns, and kept across sign-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function browserStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), clear: () => values.clear() };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.localStorage = browserStorage();
globalThis.sessionStorage = browserStorage();
globalThis.window = {};
const auth = await import('../js/auth.js');

test('sign-in sends the stored device token, keeps the new one, and sign-out leaves it', async () => {
  localStorage.setItem('plato_device', 'device-1');
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/v1/auth/login') {
      sent.push(JSON.parse(options.body).deviceToken);
      return json({ accessToken: 'access-a', refreshToken: 'refresh-a', deviceToken: 'device-2', user: { userId: 'a' } });
    }
    return json({ ok: true });
  };
  await auth.login('learner@example.com', 'right-password');
  assert.deepEqual(sent, ['device-1']);
  assert.equal(localStorage.getItem('plato_device'), 'device-2');
  await auth.logout();
  assert.equal(localStorage.getItem('plato_device'), 'device-2', 'sign-out keeps the device token');
});

test('a profile update failure carries the server code', async () => {
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'access-a', refreshToken: 'refresh-a', provider: 'password', user: { userId: 'a' } }));
  globalThis.fetch = async () => json({ error: 'Your current password is incorrect', code: 'current_password_required' }, 403);
  await assert.rejects(auth.updateProfile({ password: 'new-password', currentPassword: 'wrong' }, 'a'), { code: 'current_password_required', status: 403 });
});
