import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';

const directory = mkdtempSync(join(tmpdir(), 'plato-oauth-test-'));
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = join(directory, 'test.db');
const { default: db } = await import('../../src/lib/db.js');
const { default: admin } = await import('../../src/routes/admin.js');
const { default: aiRoute } = await import('../../src/routes/ai.js');
const { signAccessToken } = await import('../../src/lib/jwt.js');
const app = new Hono().route('/', admin).route('/', aiRoute);
app.get('/unrelated-health', c => c.json({ ok: true }));
const base = 'https://plato.example';
const path = '/v1/admin/ai-settings/cloudflare';
const callbackPath = '/v1/oauth/cloudflare/callback';
const account = { id: 'a'.repeat(32), name: 'Classroom' };
const secondAccount = { id: 'b'.repeat(32), name: 'Other account' };
const model = '@cf/mistralai/mistral-small-3.1-24b-instruct';
let calls;
let accounts;
let tokenReply;

async function request(method, suffix = '', body, userId = 'usr_admin') {
  const token = await signAccessToken(userId, userId === 'usr_learner' ? 'user' : 'admin');
  return app.request(base + path + suffix, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function start(userId) {
  const response = await request('POST', '/connect', {}, userId);
  assert.equal(response.status, 200);
  const data = await response.json();
  return { authorization: new URL(data.authorizationUrl), cookie: response.headers.get('set-cookie').split(';')[0], response };
}

async function callback(flow, query = {}) {
  const url = new URL(callbackPath, base);
  url.search = new URLSearchParams({ state: flow.authorization.searchParams.get('state'), code: 'authorization-code', ...query });
  return app.request(url, { headers: { Cookie: flow.cookie } });
}

async function connect() {
  const flow = await start();
  const response = await callback(flow);
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('cloudflare'), 'connected');
  return flow;
}

async function settings(userId = 'usr_admin') {
  const token = await signAccessToken(userId, 'admin');
  const response = await app.request(base + '/v1/admin/ai-settings', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return response.json();
}

async function infer() {
  const token = await signAccessToken('usr_admin', 'admin');
  return app.request(base + '/v1/admin/ai-settings/test', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'workers-ai', workersAiModel: model }),
  });
}

beforeEach(async () => {
  mock.restoreAll();
  for (const principal of ['_integrations', '_system']) {
    for (const row of await db.getAllSyncData(principal)) await db.deleteSyncData(principal, row.dataKey);
  }
  for (const userId of ['usr_admin', 'usr_admin2', 'usr_learner']) {
    if (!await db.getUserById(userId)) await db.createUser({ userId, email: `${userId}@example.com`, passwordHash: 'fixture', role: userId === 'usr_learner' ? 'user' : 'admin' });
    else await db.updateUser(userId, { role: userId === 'usr_learner' ? 'user' : 'admin' });
  }
  process.env.APP_URL = base;
  process.env.CLOUDFLARE_OAUTH_CLIENT_ID = 'plato-client';
  process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET = 'client-secret-do-not-return';
  process.env.CLOUDFLARE_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  calls = [];
  accounts = [account];
  tokenReply = { access_token: 'oauth-access-do-not-return', refresh_token: 'oauth-refresh-do-not-return', token_type: 'Bearer', expires_in: 3600, scope: 'ai.read ai.write account-settings.read offline_access' };
  mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    if (url.href === 'https://dash.cloudflare.com/oauth2/token') return Response.json(tokenReply);
    if (url.href === 'https://dash.cloudflare.com/oauth2/revoke') return new Response(null, { status: 200 });
    if (url.pathname === '/client/v4/accounts') return Response.json({ success: true, result: accounts, result_info: { page: 1, total_pages: 1 } });
    if (url.pathname === `/client/v4/accounts/${account.id}/ai/v1/chat/completions`) {
      return Response.json({ choices: [{ message: { content: 'Connection OK' }, finish_reason: 'stop' }] });
    }
    throw new Error('Unexpected external request');
  });
});

afterEach(() => mock.restoreAll());
after(() => rmSync(directory, { recursive: true, force: true }));

describe('Cloudflare browser connection', () => {
  it('keeps OAuth response middleware scoped to its own routes', async () => {
    const response = await app.request(base + '/unrelated-health');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('referrer-policy'), null);
    assert.equal(response.headers.get('cache-control'), null);
  });

  it('requires an administrator for starting, selecting an account and disconnecting', async () => {
    for (const [method, suffix] of [['POST', '/connect'], ['POST', '/account'], ['DELETE', '']]) {
      assert.equal((await request(method, suffix, {}, 'usr_learner')).status, 403);
      assert.equal((await app.request(base + path + suffix, { method })).status, 401);
    }
    assert.equal(calls.length, 0);
  });

  it('starts a browser-bound flow with PKCE and fixed redirect and permissions', async () => {
    const { authorization, response } = await start();
    assert.equal(authorization.origin + authorization.pathname, 'https://dash.cloudflare.com/oauth2/auth');
    assert.equal(authorization.searchParams.get('redirect_uri'), base + callbackPath);
    assert.equal(authorization.searchParams.get('response_type'), 'code');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.deepEqual(new Set(authorization.searchParams.get('scope').split(' ')), new Set(['ai.read', 'ai.write', 'account-settings.read', 'offline_access']));
    assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(response.headers.get('set-cookie'), /Secure/i);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(authorization.href, /client-secret|refresh|do-not-return/);
  });

  it('connects without a bearer header on the callback and never exposes plaintext credentials', async () => {
    const flow = await connect();
    const exchange = calls.find(call => call.url.pathname.endsWith('/token'));
    const form = new URLSearchParams(exchange.options.body);
    assert.equal(form.get('code'), 'authorization-code');
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), flow.authorization.searchParams.get('code_challenge'));
    const data = await settings();
    assert.equal(data.workersAiOAuth.connected, true);
    assert.deepEqual(data.workersAiOAuth.account, account);
    assert.equal(data.workersAiCredentials.configured, true);
    assert.equal(data.workersAiCredentials.source, 'oauth');
    const stored = JSON.stringify(await db.getAllSyncData('_integrations'));
    assert.doesNotMatch(stored, /oauth-access-do-not-return|oauth-refresh-do-not-return|client-secret-do-not-return/);
    assert.doesNotMatch(JSON.stringify(data), /oauth-access-do-not-return|oauth-refresh-do-not-return|client-secret-do-not-return|code_verifier/);
    assert.equal(data.provider, 'bedrock');
    assert.equal((await infer()).status, 200);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer oauth-access-do-not-return');
  });

  it('rejects forged state, missing cookies, expired flows and replay without exchanging tokens', async () => {
    const flow = await start();
    const forged = await callback(flow, { state: 'forged-state' });
    assert.equal(new URL(forged.headers.get('location')).searchParams.get('cloudflare'), 'invalid-state');
    const noCookie = await app.request(base + callbackPath + '?state=' + flow.authorization.searchParams.get('state') + '&code=x');
    assert.equal(new URL(noCookie.headers.get('location')).searchParams.get('cloudflare'), 'invalid-state');
    assert.equal(calls.length, 0);
    const now = Date.now();
    mock.method(Date, 'now', () => now + 11 * 60_000);
    const expired = await callback(flow);
    assert.equal(new URL(expired.headers.get('location')).searchParams.get('cloudflare'), 'invalid-state');
    assert.equal(calls.length, 0);
  });

  it('consumes the state before exchanging a code so the callback cannot be replayed', async () => {
    const flow = await connect();
    const replay = await callback(flow);
    assert.equal(new URL(replay.headers.get('location')).searchParams.get('cloudflare'), 'invalid-state');
    assert.equal(calls.filter(call => call.url.pathname.endsWith('/token')).length, 1);
  });

  it('keeps a newer browser flow usable when an older callback arrives', async () => {
    const older = await start();
    const newer = await start();
    const stale = await callback({ ...older, cookie: newer.cookie });
    assert.equal(new URL(stale.headers.get('location')).searchParams.get('cloudflare'), 'invalid-state');
    assert.equal(stale.headers.get('set-cookie'), null);
    const completed = await callback(newer);
    assert.equal(new URL(completed.headers.get('location')).searchParams.get('cloudflare'), 'connected');
  });

  it('does not accept the browser binding from a query parameter', async () => {
    const flow = await start();
    const query = new URLSearchParams({ state: flow.authorization.searchParams.get('state'), code: 'code', cookie: flow.cookie.slice(flow.cookie.indexOf('=') + 1) });
    const response = await app.request(base + callbackPath + '?' + query);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('cloudflare'), 'invalid-state');
    assert.equal(calls.length, 0);
  });

  it('uses separate browser cookies so an in-flight callback cannot clear a newer attempt', async () => {
    const older = await start();
    const originalFetch = globalThis.fetch;
    let release;
    let startedExchange;
    const started = new Promise(resolve => { startedExchange = resolve; });
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/token')) {
        startedExchange();
        await new Promise(resolve => { release = resolve; });
      }
      return originalFetch(url, options);
    };
    const pending = callback(older);
    await started;
    const newer = await start();
    assert.notEqual(older.cookie.split('=')[0], newer.cookie.split('=')[0]);
    release();
    const response = await pending;
    assert.equal(new URL(response.headers.get('location')).searchParams.get('cloudflare'), 'changed');
    assert.ok(!response.headers.get('set-cookie')?.startsWith(newer.cookie.split('=')[0] + '='));
    globalThis.fetch = originalFetch;
    assert.equal(new URL((await callback(newer)).headers.get('location')).searchParams.get('cloudflare'), 'connected');
  });

  it('exchanges a code only once when callbacks arrive at the same time', async () => {
    const flow = await start();
    const responses = await Promise.all([callback(flow), callback(flow)]);
    assert.deepEqual(responses.map(response => new URL(response.headers.get('location')).searchParams.get('cloudflare')).sort(), ['connected', 'invalid-state']);
    assert.equal(calls.filter(call => call.url.pathname.endsWith('/token')).length, 1);
  });

  it('keeps manual credentials available before OAuth and after explicit disconnect', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = account.id;
    process.env.CLOUDFLARE_API_TOKEN = 'manual-token';
    assert.equal((await infer()).status, 200);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer manual-token');
    await connect();
    assert.equal((await infer()).status, 200);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer oauth-access-do-not-return');
    await request('DELETE', '', { version: (await settings()).workersAiOAuth.version });
    assert.equal((await infer()).status, 200);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer manual-token');
  });

  it('does not activate pending credentials under a different OAuth client', async () => {
    accounts = [account, secondAccount];
    await callback(await start());
    const data = await settings();
    process.env.CLOUDFLARE_OAUTH_CLIENT_ID = 'replacement-client';
    const response = await request('POST', '/account', { accountId: account.id, flowId: data.workersAiOAuth.pendingFlowId });
    assert.equal(response.status, 409);
    assert.equal((await settings()).workersAiOAuth.connected, false);
  });

  it('handles denial without changing the connected account or reflecting upstream errors', async () => {
    await connect();
    const flow = await start();
    const response = await callback(flow, { error: 'access_denied', error_description: 'private-upstream-error' });
    assert.equal(new URL(response.headers.get('location')).searchParams.get('cloudflare'), 'denied');
    assert.doesNotMatch(response.headers.get('location'), /private-upstream-error/);
    assert.equal((await settings()).workersAiOAuth.connected, true);
  });

  it('rechecks the initiating administrator before exchanging the code', async () => {
    const flow = await start();
    await db.updateUser('usr_admin', { role: 'user' });
    const response = await callback(flow);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('cloudflare'), 'invalid-state');
    assert.equal(calls.length, 0);
  });

  it('requires an explicit account choice when consent authorizes multiple accounts', async () => {
    accounts = [account, secondAccount];
    const response = await callback(await start());
    assert.equal(new URL(response.headers.get('location')).searchParams.get('cloudflare'), 'select-account');
    const data = await settings();
    assert.equal(data.workersAiOAuth.connected, false);
    assert.deepEqual(data.workersAiOAuth.pendingAccounts, accounts);
    assert.equal((await settings('usr_admin2')).workersAiOAuth.pendingAccounts.length, 0);
    const wrongAccount = await request('POST', '/account', { accountId: 'c'.repeat(32), flowId: data.workersAiOAuth.pendingFlowId });
    assert.equal(wrongAccount.status, 400);
    const chosen = await request('POST', '/account', { accountId: account.id, flowId: data.workersAiOAuth.pendingFlowId });
    assert.equal(chosen.status, 200);
    assert.deepEqual((await settings()).workersAiOAuth.account, account);
  });

  it('refreshes an expiring token once for concurrent inference and persists rotation', async () => {
    tokenReply.expires_in = 90;
    await connect();
    const now = Date.now();
    mock.method(Date, 'now', () => now + 60_000);
    tokenReply = { ...tokenReply, access_token: 'rotated-access', refresh_token: 'rotated-refresh' };
    const replies = await Promise.all([infer(), infer(), infer()]);
    assert.deepEqual(replies.map(reply => reply.status), [200, 200, 200]);
    const refreshes = calls.filter(call => call.url.pathname.endsWith('/token') && new URLSearchParams(call.options.body).get('grant_type') === 'refresh_token');
    assert.equal(refreshes.length, 1);
    assert.equal(new URLSearchParams(refreshes[0].options.body).get('refresh_token'), 'oauth-refresh-do-not-return');
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer rotated-access');
    assert.doesNotMatch(JSON.stringify(await db.getAllSyncData('_integrations')), /rotated-access|rotated-refresh/);
  });

  it('disconnects before revocation and an older callback cannot restore the connection', async () => {
    await connect();
    const flow = await start();
    const data = await settings();
    assert.equal((await request('DELETE', '', { version: data.workersAiOAuth.version })).status, 200);
    const response = await callback(flow);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('cloudflare'), 'changed');
    assert.equal((await settings()).workersAiOAuth.connected, false);
    assert.equal((await infer()).status, 503);
  });

  it('refuses a stale disconnect so another admin connection is preserved', async () => {
    await connect();
    const previous = await settings();
    await connect();
    assert.equal((await request('DELETE', '', { version: previous.workersAiOAuth.version })).status, 409);
    assert.equal((await settings()).workersAiOAuth.connected, true);
  });

  it('requires reconnect after a failed refresh, keeps revoke-only credentials, and never switches to manual credentials', async () => {
    tokenReply.expires_in = 90;
    await connect();
    const now = Date.now();
    mock.method(Date, 'now', () => now + 60_000);
    process.env.CLOUDFLARE_ACCOUNT_ID = secondAccount.id;
    process.env.CLOUDFLARE_API_TOKEN = 'manual-other-account';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => String(url).endsWith('/token')
      ? Promise.resolve(Response.json({ error: 'invalid_grant', error_description: 'private error details' }, { status: 400 }))
      : originalFetch(url, options);
    assert.equal((await infer()).status, 503);
    assert.equal((await settings()).workersAiOAuth.needsReconnect, true);
    assert.equal((await infer()).status, 503);
    const data = await settings();
    await request('DELETE', '', { version: data.workersAiOAuth.version });
    assert.equal(calls.filter(call => call.url.pathname.endsWith('/revoke')).length, 2);
  });

  it('retains failed revocation for a later retry while credentials remain disabled', async () => {
    await connect();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => String(url).endsWith('/revoke')
      ? Promise.resolve(new Response('private error', { status: 503 })) : originalFetch(url, options);
    let data = await settings();
    const disconnected = await request('DELETE', '', { version: data.workersAiOAuth.version });
    assert.equal((await disconnected.json()).revocationPending, true);
    data = await settings();
    assert.equal(data.workersAiOAuth.connected, false);
    assert.equal(data.workersAiOAuth.revocationPending, true);
    assert.equal((await infer()).status, 503);
    globalThis.fetch = originalFetch;
    const retried = await request('DELETE', '', { version: data.workersAiOAuth.version });
    assert.equal((await retried.json()).revocationPending, false);
    assert.equal(calls.filter(call => call.url.pathname.endsWith('/revoke')).length, 2);
    assert.equal((await settings()).workersAiOAuth.revocationPending, false);
  });

  it('does not resurrect disconnected credentials when a refresh completes late', async () => {
    tokenReply.expires_in = 90;
    await connect();
    const now = Date.now();
    mock.method(Date, 'now', () => now + 60_000);
    const originalFetch = globalThis.fetch;
    let release;
    let refreshStarted;
    const started = new Promise(resolve => { refreshStarted = resolve; });
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/token')) {
        refreshStarted();
        await new Promise(resolve => { release = resolve; });
        return Response.json({ ...tokenReply, expires_in: 3600, access_token: 'late-access' });
      }
      return originalFetch(url, options);
    };
    const pendingInference = infer();
    await started;
    const data = await settings();
    assert.equal((await request('DELETE', '', { version: data.workersAiOAuth.version })).status, 200);
    release();
    assert.equal((await pendingInference).status, 503);
    assert.equal((await settings()).workersAiOAuth.connected, false);
    assert.equal(calls.filter(call => call.url.pathname.includes('/chat/completions')).length, 0);
  });

  it('does not activate an authorization exchange that completes after disconnect', async () => {
    const flow = await start();
    const originalFetch = globalThis.fetch;
    let release;
    let startedExchange;
    const started = new Promise(resolve => { startedExchange = resolve; });
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/token')) {
        startedExchange();
        await new Promise(resolve => { release = resolve; });
      }
      return originalFetch(url, options);
    };
    const pending = callback(flow);
    await started;
    assert.equal((await request('DELETE', '', { version: 0 })).status, 200);
    release();
    const response = await pending;
    assert.equal(new URL(response.headers.get('location')).searchParams.get('cloudflare'), 'changed');
    assert.equal((await settings()).workersAiOAuth.connected, false);
    assert.deepEqual((await settings()).workersAiOAuth.pendingAccounts, []);
  });

  it('does not retry a refresh token after an abandoned lease expires, but can still revoke it', async () => {
    tokenReply.expires_in = 90;
    await connect();
    const rows = await db.getAllSyncData('_integrations');
    const row = rows.find(item => item.data.status === 'connected');
    await db.putSyncData('_integrations', row.dataKey, { ...row.data, refreshLease: { id: 'abandoned', until: Date.now() - 1 } }, row.version, { strictVersion: true });
    const now = Date.now();
    mock.method(Date, 'now', () => now + 60_000);
    assert.equal((await infer()).status, 503);
    assert.equal(calls.filter(call => call.url.pathname.endsWith('/token')).length, 1);
    const data = await settings();
    assert.equal(data.workersAiOAuth.needsReconnect, true);
    await request('DELETE', '', { version: data.workersAiOAuth.version });
    assert.equal(calls.filter(call => call.url.pathname.endsWith('/revoke')).length, 2);
  });

  it('reports one-time setup requirements and rejects insecure production callback origins', async () => {
    delete process.env.CLOUDFLARE_OAUTH_ENCRYPTION_KEY;
    assert.equal((await settings()).workersAiOAuth.available, false);
    assert.equal((await request('POST', '/connect', {})).status, 503);
    process.env.CLOUDFLARE_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_URL = 'http://public.example';
    assert.equal((await request('POST', '/connect', {})).status, 503);
    assert.equal(calls.length, 0);
  });
});
