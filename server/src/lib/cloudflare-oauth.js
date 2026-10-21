import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import db from './db.js';
import { APP_URL } from '../config.js';

const PRINCIPAL = '_integrations';
const CONNECTION_KEY = 'cloudflare-ai';
const FLOW_TTL = 10 * 60_000;
const CALLBACK = '/v1/oauth/cloudflare/callback';
export const CLOUDFLARE_OAUTH_COOKIE = 'plato_cf_oauth';
export const CLOUDFLARE_OAUTH_SCOPES = ['ai.read', 'ai.write', 'account-settings.read', 'offline_access'];
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const ERRORS = {
  'setup-required': 'Browser connection has not been enabled on this server. Ask the server owner to complete Cloudflare OAuth setup.',
  'invalid-state': 'This Cloudflare connection request expired or is no longer valid. Connect again from AI settings.',
  denied: 'Cloudflare access was not approved. You can connect again when ready.',
  failed: 'Cloudflare could not be connected. Try connecting again.',
  changed: 'The Cloudflare connection changed in another session. Reload AI settings before trying again.',
  'invalid-account': 'Choose one of the accounts authorized through Cloudflare.',
  'reconnect-required': 'Reconnect Cloudflare in AI settings to restore Workers AI access.',
  busy: 'Cloudflare credentials are being renewed. Try again shortly.',
};

function failure(code, status = 400) {
  return Object.assign(new Error(ERRORS[code]), { name: 'CloudflareOAuthError', code, status });
}

function appOrigin() {
  try {
    const url = new URL(process.env.APP_URL || APP_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error();
    return url.origin;
  } catch { throw failure('setup-required', 503); }
}

function encryptionKey() {
  const value = process.env.CLOUDFLARE_OAUTH_ENCRYPTION_KEY || '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw failure('setup-required', 503);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw failure('setup-required', 503);
  return key;
}

function configuration() {
  const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim();
  if (!clientId || clientId.length > 256) throw failure('setup-required', 503);
  encryptionKey();
  return { clientId, origin: appOrigin(), clientSecret: process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET?.trim() };
}

function seal(value, purpose) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`plato-cloudflare-v1:${purpose}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

function unseal(value, purpose) {
  try {
    if (typeof value !== 'string') throw new Error();
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error();
    const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAAD(Buffer.from(`plato-cloudflare-v1:${purpose}`));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
  } catch { throw failure('reconnect-required', 503); }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function cloudflareOAuthCookieName(state) {
  return typeof state === 'string' && /^[A-Za-z0-9_-]{43}$/.test(state)
    ? `${CLOUDFLARE_OAUTH_COOKIE}_${hash(state).slice(0, 16)}` : null;
}

function equalHash(value, expected) {
  return typeof value === 'string' && typeof expected === 'string' && expected.length === 64
    && timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(expected, 'hex'));
}

const flowKey = userId => `cloudflare-flow:${userId}`;
const read = key => db.getSyncData(PRINCIPAL, key, { consistentRead: true });
const write = (key, data, version) => db.putSyncData(PRINCIPAL, key, data, version, { strictVersion: true });
const conflict = error => error.name === 'ConditionalCheckFailedException';

async function compareAndWrite(key, data, version) {
  try { return await write(key, data, version); }
  catch (error) { if (conflict(error)) throw failure('changed', 409); throw error; }
}

async function providerFetch(url, options) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw failure('failed', 502);
    }
    return response;
  } catch { throw failure('failed', 502); }
}

async function tokenRequest(parameters, previousRefreshToken) {
  const { clientId, clientSecret } = configuration();
  const form = new URLSearchParams({ ...parameters, client_id: clientId });
  if (clientSecret) form.set('client_secret', clientSecret);
  const response = await providerFetch('https://dash.cloudflare.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  let data;
  try { data = await response.json(); } catch { throw failure('failed', 502); }
  if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 65_536
    || typeof (data.refresh_token ?? previousRefreshToken) !== 'string' || !(data.refresh_token ?? previousRefreshToken)
    || data.token_type?.toLowerCase() !== 'bearer'
    || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31_536_000) throw failure('failed', 502);
  if (data.scope && !CLOUDFLARE_OAUTH_SCOPES.every(scope => data.scope.split(' ').includes(scope))) throw failure('failed', 502);
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? previousRefreshToken, expiresAt: Date.now() + data.expires_in * 1000 };
}

async function authorizedAccounts(accessToken) {
  const accounts = new Map();
  for (let page = 1; page <= 20; page++) {
    const response = await providerFetch(`https://api.cloudflare.com/client/v4/accounts?per_page=50&page=${page}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    let data;
    try { data = await response.json(); } catch { throw failure('failed', 502); }
    if (data.success !== true || !Array.isArray(data.result)) throw failure('failed', 502);
    for (const account of data.result) {
      if (!ACCOUNT_ID.test(account.id) || typeof account.name !== 'string') throw failure('failed', 502);
      accounts.set(account.id, { id: account.id, name: account.name.slice(0, 200) });
    }
    if (data.result_info?.total_pages ? page >= data.result_info.total_pages : data.result.length < 50) return [...accounts.values()];
  }
  throw failure('failed', 502);
}

export function cloudflareReturnUrl(result) {
  let origin;
  try { origin = appOrigin(); } catch { origin = ''; }
  return `${origin}/plato/ai?cloudflare=${Object.hasOwn(ERRORS, result) || ['connected', 'select-account'].includes(result) ? result : 'failed'}`;
}

export async function beginCloudflareOAuth(userId) {
  const { clientId, origin } = configuration();
  const [connection, previousFlow] = await Promise.all([read(CONNECTION_KEY), read(flowKey(userId))]);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const cookie = seal({ userId, nonce: randomBytes(32).toString('base64url') }, 'browser');
  await compareAndWrite(flowKey(userId), {
    status: 'pending', flowId: randomUUID(), clientId, origin, stateHash: hash(state), cookieHash: hash(cookie),
    verifier: seal(verifier, 'verifier'), expiresAt: Date.now() + FLOW_TTL, connectionVersion: connection?.version || 0,
  }, previousFlow?.version || 0);
  const url = new URL('https://dash.cloudflare.com/oauth2/auth');
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: origin + CALLBACK, response_type: 'code',
    scope: CLOUDFLARE_OAUTH_SCOPES.join(' '), state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return { authorizationUrl: url.href, cookie, cookieName: cloudflareOAuthCookieName(state), secure: origin.startsWith('https:') };
}

async function activateAccount(userId, flow, accountId) {
  if (flow.data.clientId !== configuration().clientId || flow.data.origin !== configuration().origin) throw failure('changed', 409);
  unseal(flow.data.sealedTokens, 'tokens');
  const account = flow.data.accounts.find(item => item.id === accountId);
  if (!account) throw failure('invalid-account');
  const connection = await read(CONNECTION_KEY);
  if ((connection?.version || 0) !== flow.data.connectionVersion) throw failure('changed', 409);
  // Consume before activation. A stale tab cannot select again or resurrect a
  // connection after disconnect; connection tombstones retain their version.
  await compareAndWrite(flowKey(userId), { status: 'consumed' }, flow.version);
  await compareAndWrite(CONNECTION_KEY, {
    status: 'connected', account, clientId: configuration().clientId, sealedTokens: flow.data.sealedTokens,
    expiresAt: flow.data.expiresAtToken, connectedAt: new Date().toISOString(), connectedBy: userId,
  }, connection?.version || 0);
}

export async function finishCloudflareOAuth({ cookie, state, code, error }) {
  let userId;
  try { userId = unseal(cookie, 'browser').userId; } catch { throw failure('invalid-state'); }
  if (typeof userId !== 'string') throw failure('invalid-state');
  const flow = await read(flowKey(userId));
  if (!flow || flow.data.status !== 'pending' || flow.data.expiresAt <= Date.now()
    || !equalHash(state, flow.data.stateHash) || !equalHash(cookie, flow.data.cookieHash)) throw failure('invalid-state');
  const user = await db.getUserById(userId);
  if (user?.role !== 'admin') throw failure('invalid-state');
  if (flow.data.clientId !== configuration().clientId || flow.data.origin !== configuration().origin) throw failure('changed', 409);
  try { await write(flowKey(userId), { status: 'exchanging' }, flow.version); }
  catch (err) { if (conflict(err)) throw failure('invalid-state'); throw err; }
  try {
    if (error) throw failure(error === 'access_denied' ? 'denied' : 'failed');
    const connection = await read(CONNECTION_KEY);
    if ((connection?.version || 0) !== flow.data.connectionVersion) throw failure('changed', 409);
    if (typeof code !== 'string' || !code || code.length > 4096) throw failure('failed');
    const tokens = await tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: configuration().origin + CALLBACK,
      code_verifier: unseal(flow.data.verifier, 'verifier'),
    });
    const accounts = await authorizedAccounts(tokens.accessToken);
    if (!accounts.length) throw failure('failed');
    const pending = {
      status: 'select-account', flowId: flow.data.flowId, clientId: flow.data.clientId, origin: flow.data.origin, accounts, sealedTokens: seal(tokens, 'tokens'),
      expiresAtToken: tokens.expiresAt, expiresAt: Date.now() + FLOW_TTL, connectionVersion: flow.data.connectionVersion,
    };
    const saved = await compareAndWrite(flowKey(userId), pending, flow.version + 1);
    if (accounts.length === 1) {
      await activateAccount(userId, { data: pending, version: saved.version }, accounts[0].id);
      return 'connected';
    }
    return 'select-account';
  } catch (err) {
    // Only a consumed, browser-matched callback may clear its cookie. An old
    // callback must not invalidate the cookie of a newer attempt in this tab.
    err.flowConsumed = true;
    throw err;
  }
}

export async function selectCloudflareAccount(userId, { accountId, flowId } = {}) {
  const flow = await read(flowKey(userId));
  if (!flow || flow.data.status !== 'select-account' || flow.data.expiresAt <= Date.now() || flow.data.flowId !== flowId) throw failure('invalid-state');
  await activateAccount(userId, flow, accountId);
}

async function revoke(tokens) {
  const { clientId, clientSecret } = configuration();
  // Persist local disconnect first. Provider unavailability cannot keep local
  // credentials active. Revocation never includes a token in a URL or log.
  for (const [token, hint] of [[tokens.refreshToken, 'refresh_token'], [tokens.accessToken, 'access_token']]) {
    const form = new URLSearchParams({ client_id: clientId, token, token_type_hint: hint });
    if (clientSecret) form.set('client_secret', clientSecret);
    await providerFetch('https://dash.cloudflare.com/oauth2/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    });
  }
}

export async function disconnectCloudflareOAuth(version) {
  if (!Number.isSafeInteger(version) || version < 0) throw failure('changed', 409);
  const connection = await read(CONNECTION_KEY);
  if ((connection?.version || 0) !== version) throw failure('changed', 409);
  const tombstone = {
    status: 'disconnected', revocationPending: Boolean(connection?.data.sealedTokens),
    ...(connection?.data.sealedTokens ? { sealedTokens: connection.data.sealedTokens, clientId: connection.data.clientId } : {}),
  };
  const saved = await compareAndWrite(CONNECTION_KEY, tombstone, version);
  if (!connection?.data.sealedTokens) return { revocationPending: false };
  try {
    if (connection.data.clientId !== configuration().clientId) return { revocationPending: true };
    await revoke(unseal(connection.data.sealedTokens, 'tokens'));
    try { await write(CONNECTION_KEY, { status: 'disconnected', revocationPending: false }, saved.version); }
    catch (err) { if (!conflict(err)) throw err; }
    return { revocationPending: false };
  }
  catch { return { revocationPending: true }; }
}

export function environmentCredentialStatus() {
  const accountId = ACCOUNT_ID.test(process.env.CLOUDFLARE_ACCOUNT_ID || '');
  const apiToken = Boolean(process.env.CLOUDFLARE_API_TOKEN?.trim());
  return { accountId, apiToken, configured: accountId && apiToken, source: accountId && apiToken ? 'environment' : null };
}

export async function cloudflareCredentialStatus(userId) {
  const [connection, flow] = await Promise.all([read(CONNECTION_KEY), userId ? read(flowKey(userId)) : null]);
  let available = true;
  try { configuration(); } catch { available = false; }
  let connected = connection?.data.status === 'connected';
  if (connected) {
    try {
      const tokens = unseal(connection.data.sealedTokens, 'tokens');
      connected = available && connection.data.clientId === configuration().clientId && Boolean(tokens.refreshToken);
    } catch { connected = false; }
  }
  const needsReconnect = Boolean(connection && connection.data.status !== 'disconnected' && !connected);
  const pending = flow?.data.status === 'select-account' && flow.data.expiresAt > Date.now()
    && flow.data.connectionVersion === (connection?.version || 0);
  return {
    workersAiCredentials: connected ? { accountId: true, apiToken: true, configured: true, source: 'oauth' }
      : needsReconnect ? { accountId: false, apiToken: false, configured: false, source: 'oauth' } : environmentCredentialStatus(),
    workersAiOAuth: {
      available, connected, needsReconnect, revocationPending: Boolean(connection?.data.revocationPending), version: connection?.version || 0,
      account: connection?.data.account || null,
      pendingAccounts: pending ? flow.data.accounts : [], pendingFlowId: pending ? flow.data.flowId : null,
    },
  };
}

async function oauthCredentials() {
  // A DB lease coordinates refresh-token rotation across processes, Lambda
  // functions and Cloud Run instances. Never retry a possibly rotated token.
  for (let attempt = 0; attempt < 160; attempt++) {
    const connection = await read(CONNECTION_KEY);
    if (!connection || connection.data.status === 'disconnected') return null;
    if (connection.data.status !== 'connected' || connection.data.clientId !== configuration().clientId) throw failure('reconnect-required', 503);
    const tokens = unseal(connection.data.sealedTokens, 'tokens');
    if (tokens.expiresAt > Date.now() + 60_000) return { accountId: connection.data.account.id, apiToken: tokens.accessToken };
    if (connection.data.refreshLease) {
      if (connection.data.refreshLease.until <= Date.now()) {
        try { await write(CONNECTION_KEY, { ...connection.data, status: 'reconnect-required', refreshLease: null }, connection.version); }
        catch (err) { if (conflict(err)) continue; throw err; }
        throw failure('reconnect-required', 503);
      }
      await delay(100);
      continue;
    }
    const lease = { id: randomUUID(), until: Date.now() + 30_000 };
    try { await write(CONNECTION_KEY, { ...connection.data, refreshLease: lease }, connection.version); }
    catch (err) { if (conflict(err)) continue; throw err; }
    let renewed;
    try { renewed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, tokens.refreshToken); }
    catch {
      try { await write(CONNECTION_KEY, { ...connection.data, status: 'reconnect-required', refreshLease: null }, connection.version + 1); }
      catch (err) { if (!conflict(err)) throw err; }
      throw failure('reconnect-required', 503);
    }
    try {
      await write(CONNECTION_KEY, { ...connection.data, sealedTokens: seal(renewed, 'tokens'), expiresAt: renewed.expiresAt, refreshLease: null }, connection.version + 1);
      return { accountId: connection.data.account.id, apiToken: renewed.accessToken };
    } catch (err) { if (!conflict(err)) throw err; }
    // A disconnect/reconnect won the race. Read that decision; do not use or
    // persist the old token and do not resurrect its connection.
  }
  throw failure('busy', 503);
}

export async function workersAiCredentials() {
  try {
    const oauth = await oauthCredentials();
    if (oauth) return oauth;
    if (environmentCredentialStatus().configured) return { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, apiToken: process.env.CLOUDFLARE_API_TOKEN };
  } catch {
    throw Object.assign(new Error(ERRORS['reconnect-required']), { name: 'AiConfigurationError' });
  }
  throw Object.assign(new Error('Connect Cloudflare in AI settings or configure Workers AI credentials on the server.'), { name: 'AiConfigurationError' });
}
