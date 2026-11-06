import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeGoogleToken } from '../../plugins/google-auth/client/exchange.js';

const originalFetch = globalThis.fetch;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

afterEach(() => { globalThis.fetch = originalFetch; });

test('Google token exchange uses the plugin endpoint and returns the server-issued session', async () => {
  const issued = {
    accessToken: 'google-access',
    refreshToken: 'google-refresh',
    user: { userId: 'learner', email: 'learner@example.test' },
  };
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return json(issued);
  };
  assert.deepEqual(await exchangeGoogleToken('verified-google-token', { inviteToken: 'invite' }), issued);
  assert.equal(request.url, '/v1/plugins/google-auth/exchange');
  assert.equal(request.options.method, 'POST');
  assert.equal(new Headers(request.options.headers).get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { idToken: 'verified-google-token', inviteToken: 'invite' });
});

test('a Google account without an invitation receives typed admission details', async () => {
  globalThis.fetch = async () => json({
    error: 'Membership is by invitation only. Ask your program admin for an invitation.',
    code: 'invite_required',
    email: 'new@example.test',
    name: 'New Learner',
    waitlisted: true,
    inviteExpired: false,
  }, 403);
  await assert.rejects(exchangeGoogleToken('verified-google-token'), err => {
    assert.equal(err.status, 403);
    assert.equal(err.code, 'invite_required');
    assert.deepEqual(err.admission, {
      email: 'new@example.test',
      name: 'New Learner',
      waitlisted: true,
      inviteExpired: false,
    });
    return true;
  });
});

test('admission details keep only the expected types from the reply', async () => {
  globalThis.fetch = async () => json({
    code: 'invite_required', email: 42, name: null, waitlisted: 'yes', inviteExpired: 1,
  }, 403);
  await assert.rejects(exchangeGoogleToken('verified-google-token'), err => {
    assert.deepEqual(err.admission, { email: '', name: '', waitlisted: false, inviteExpired: false });
    return true;
  });
});

test('other Google exchange failures carry no admission details', async () => {
  globalThis.fetch = async () => json({ error: 'This invite is for a different email address' }, 400);
  await assert.rejects(exchangeGoogleToken('verified-google-token', { inviteToken: 'invite' }), err => {
    assert.equal(err.message, 'This invite is for a different email address');
    assert.equal(err.status, 400);
    assert.equal(err.admission, undefined);
    return true;
  });
});
