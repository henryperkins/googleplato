import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const session = id => ({ accessToken: `access-${id}`, refreshToken: `refresh-${id}`, provider: 'password', user: { userId: id, name: `Account ${id}`, role: 'learner' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let browser, server, base;
async function pair({ fallback = false, classroom = false } = {}) {
  const context = await browser.newContext();
  if (fallback) await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  const revoked = [], writes = [];
  await context.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/auth/logout') revoked.push(route.request().postDataJSON().refreshToken);
    if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON());
    const body = path === '/v1/auth/login' ? session(route.request().postDataJSON().email)
      : path === '/v1/me' ? session('x').user : {};
    await route.fulfill({ json: body });
  });
  const a = await context.newPage();
  await a.goto(`${base}/tests/browser/fixtures/auth-tabs.html${classroom ? '?classroom' : ''}`);
  await a.waitForFunction(() => window.authHarness && !window.authHarness.loading);
  const b = await context.newPage();
  await b.goto(`${base}/tests/browser/fixtures/auth-tabs.html`);
  await b.waitForFunction(() => window.authHarness && !window.authHarness.loading);
  return { context, a, b, revoked, writes };
}
async function login(page, id) { await page.evaluate(id => window.authHarness.login(id, 'password'), id); }
async function startProvider(page, id) {
  await page.evaluate(async id => {
    window.provider = window.authHarness.createPublicAuthSessionGuard()({ id }, {
      onSession: (session, provider, attempt) => window.authHarness.adoptExternalSession(session, provider, attempt),
    });
    await window.provider.beforeStart();
  }, id);
}
async function finishProvider(page, id) {
  return page.evaluate(async session => {
    try { await window.provider.onSession(session, 'google-auth'); return null; }
    catch (error) { return error.code; }
  }, session(id));
}
async function stored(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('plato_auth'))); }

describe('auth intent across independent tabs sharing storage', { timeout: 120000 }, () => {
  before(async () => {
    const reservation = createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: `${root}/client`, stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      let output = '';
      server.stdout.on('data', chunk => { output += chunk; if (output.includes(base)) resolve(); });
      server.on('exit', code => reject(new Error(`Vite exited ${code}: ${output}`)));
    });
    browser = await chromium.launch();
  });
  after(async () => { await browser?.close(); if (server?.exitCode === null) { const done = once(server, 'exit'); server.kill(); await done; } });

  for (const fallback of [false, true]) for (const transition of ['login', 'logout']) {
    it(`a held password completion cannot overwrite ${transition}; Web Locks ${!fallback}`, async () => {
      const { context, a, b, revoked } = await pair({ fallback });
      const held = deferred(), received = deferred();
      try {
        const diagnostics = [];
        a.on('console', message => diagnostics.push(message.text()));
        await a.route('**/v1/auth/login', async route => { received.resolve(); await held.promise; await route.fulfill({ json: session('slow') }); });
        await a.evaluate(() => { window.pending = window.authHarness.login('slow', 'password').then(() => null, error => error.code); });
        await received.promise;
        if (transition === 'login') await login(b, 'y'); else await b.evaluate(() => window.authHarness.logout());
        const revoke = a.waitForResponse('**/v1/auth/logout');
        revoke.catch(() => {});
        held.resolve();
        assert.equal(await a.evaluate(() => window.pending), 'stale_auth_exchange');
        await revoke;
        assert.deepEqual(revoked, ['refresh-slow']);
        assert.equal((await stored(a))?.user.userId || null, transition === 'login' ? 'y' : null);
        assert.equal(await a.evaluate(() => window.publishedUsers.includes('Account slow')), false);
        if (fallback) assert.ok(diagnostics.some(line => line.includes('auth_coordination_unavailable')));
      } finally { held.resolve(); await context.close(); }
    });
  }
  for (const fallback of [false, true]) for (const transition of ['login', 'logout']) {
    it(`a held Google exchange cannot overwrite cross-tab ${transition}; Web Locks ${!fallback}`, async () => {
      const { context, a, b, revoked } = await pair({ fallback });
      const held = deferred(), received = deferred();
      try {
        await startProvider(a, 'google-auth');
        await a.route('**/v1/plugins/google-auth/exchange', async route => { received.resolve(); await held.promise; await route.fulfill({ json: session('slow-google') }); });
        await a.evaluate(() => { window.pending = fetch('/v1/plugins/google-auth/exchange', { method: 'POST' }).then(r => r.json()).then(s => window.provider.onSession(s, 'google-auth')).then(() => null, e => e.code); });
        await received.promise;
        if (transition === 'login') await login(b, 'y'); else await b.evaluate(() => window.authHarness.logout());
        const revoke = a.waitForResponse('**/v1/auth/logout');
        revoke.catch(() => {});
        held.resolve();
        assert.equal(await a.evaluate(() => window.pending), 'stale_auth_exchange');
        await revoke;
        assert.deepEqual(revoked, ['refresh-slow-google']);
        assert.equal((await stored(a))?.user.userId || null, transition === 'login' ? 'y' : null);
      } finally { held.resolve(); await context.close(); }
    });
  }
  for (const order of ['ab', 'ba']) {
    it(`the later provider start wins with completion order ${order}`, async () => {
      const { context, a, b, revoked } = await pair();
      try {
        await startProvider(a, 'google-auth'); await startProvider(b, 'another-provider');
        const revoke = a.waitForResponse('**/v1/auth/logout');
        revoke.catch(() => {});
        if (order === 'ba') assert.equal(await finishProvider(b, 'y'), null);
        assert.equal(await finishProvider(a, 'x'), 'stale_auth_exchange');
        if (order === 'ab') assert.equal(await finishProvider(b, 'y'), null);
        await revoke;
        assert.deepEqual(revoked, ['refresh-x']);
        assert.equal((await stored(a)).user.userId, 'y');
      } finally { await context.close(); }
    });
  }
  for (const change of ['relogin', 'rotation']) {
    it(`${change} ${change === 'rotation' ? 'preserves' : 'invalidates'} pending requests and session publications`, async () => {
      const { context, a, b } = await pair();
      const held = deferred(), received = deferred();
      try {
        await login(a, 'x');
        await a.route('**/v1/pending', async route => { received.resolve(); await held.promise; await route.fulfill({ json: { ok: true } }); });
        await a.evaluate(async () => {
          window.captured = await window.core.auth.captureAuthSession();
          window.pending = window.core.auth.authenticatedFetch('/v1/pending').then(() => 'ok', () => 'changed');
        });
        await received.promise;
        if (change === 'relogin') { await b.evaluate(() => window.authHarness.logout()); await login(b, 'x'); }
        else {
          await b.goto(`${base}/tests/browser/fixtures/auth-tabs.html`);
          await b.waitForFunction(() => window.authHarness?.user?.userId === 'x');
          await b.route('**/v1/rotate', route => route.fulfill({ status: route.request().headers().authorization === 'Bearer access-x' ? 401 : 200, json: {} }));
          await b.route('**/v1/auth/refresh', route => route.fulfill({ json: { accessToken: 'rotated', refreshToken: 'rotated-refresh' } }));
          await b.evaluate(() => window.core.auth.authenticatedFetch('/v1/rotate'));
        }
        await a.waitForFunction(() => window.events.includes('plato_auth'));
        held.resolve();
        assert.equal(await a.evaluate(() => window.pending), change === 'rotation' ? 'ok' : 'changed');
        assert.equal(await a.evaluate(() => window.core.auth.isAuthSessionCurrent(window.captured)), change === 'rotation');
      } finally { held.resolve(); await context.close(); }
    });
  }
  it('tears down classroom drafts and clears cache before navigating to the next account', async () => {
    const { context, a, b, writes } = await pair({ classroom: true });
    const navigation = deferred(), arrived = deferred(), teardown = deferred();
    try {
      await a.exposeFunction('reportTeardown', result => teardown.resolve(result));
      await login(a, 'x');
      await a.evaluate(() => window.core.storage._populateCache('lessonKB:draft', { old: true }, 1));
      await a.route('**/lessons', async route => { arrived.resolve(); await navigation.promise; await route.fulfill({ body: '<main>New classroom</main>', contentType: 'text/html' }); });
      await login(b, 'y');
      const result = await Promise.race([teardown.promise, a.waitForFunction(() => window.unmounted === true, null, { timeout: 3000 }).then(() => teardown.promise)]);
      assert.equal(result.cache, undefined);
      assert.deepEqual(writes, []);
      await arrived.promise;
      navigation.resolve(); await a.waitForURL('**/lessons');
    } finally { navigation.resolve(); await context.close(); }
  });
  for (const form of ['signup', 'setup']) {
    it(`${form} owns its intent before its first network request`, async () => {
      const { context, a, b, revoked } = await pair();
      const held = deferred(), received = deferred();
      try {
        await a.route('**/v1/auth/providers', route => route.fulfill({ json: [] }));
        await a.route(`**/v1/auth/${form}`, async route => {
          received.resolve(); await held.promise;
          await route.fulfill({ json: form === 'setup' ? session('slow') : { user: { email: 'slow' } } });
        });
        await a.goto(`${base}/tests/browser/fixtures/auth-form.html${form === 'setup' ? '?setup' : ''}`);
        await a.getByLabel('Email', { exact: true }).fill('slow@example.test');
        await a.getByLabel('First name', { exact: false }).fill('Slow');
        await a.getByLabel('Password', { exact: true }).fill('password123');
        await a.getByLabel('Confirm password', { exact: true }).fill('password123');
        await a.getByRole('button', { name: form === 'setup' ? 'Create admin account' : 'Create account', exact: true }).click();
        await received.promise;
        await login(b, 'y');
        const revoke = a.waitForResponse('**/v1/auth/logout'); revoke.catch(() => {});
        held.resolve();
        await a.getByText('You started another sign-in', { exact: false }).waitFor({ timeout: 3000 });
        await revoke;
        assert.equal((await stored(b)).user.userId, 'y');
        assert.deepEqual(revoked, ['refresh-slow']);
      } finally { held.resolve(); await context.close(); }
    });
  }
  it('same-user cross-tab relogin cannot publish the old mounted profile response', async () => {
    const { context, a, b } = await pair();
    const held = deferred(), received = deferred();
    try {
      await login(a, 'x');
      await a.addInitScript(() => {
        const realFetch = window.fetch;
        window.fetch = async (...args) => {
          const response = await realFetch(...args);
          if (args[0] === '/v1/me') window.profileReceived = true;
          return response;
        };
      });
      await a.route('**/v1/me', async route => { received.resolve(); await held.promise; await route.fulfill({ json: { userId: 'x', name: 'Stale profile', role: 'admin' } }); });
      await a.goto(`${base}/tests/browser/fixtures/auth-tabs.html`);
      await received.promise;
      await a.waitForFunction(() => window.authHarness?.user?.userId === 'x');
      await b.evaluate(() => window.authHarness.logout());
      await login(b, 'x');
      held.resolve();
      await a.waitForFunction(() => window.profileReceived);
      await a.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await a.evaluate(() => window.publishedUsers.includes('Stale profile')), false);
      assert.equal((await stored(a)).user.name, 'Account x');
    } finally { held.resolve(); await context.close(); }
  });
  it('cross-tab signout destroys the classroom and navigates to sign-in', async () => {
    const { context, a, b } = await pair({ classroom: true });
    try {
      await login(a, 'x');
      await a.route('**/login', route => route.fulfill({ body: '<main>Sign in</main>', contentType: 'text/html' }));
      await b.evaluate(() => window.authHarness.logout());
      await a.waitForURL('**/login');
      assert.equal(await stored(a), null);
    } finally { await context.close(); }
  });
  it('logout fences local access while waiting for the shared auth lock', async () => {
    const { context, a, b } = await pair();
    try {
      await login(b, 'x');
      await a.evaluate(() => {
        window.lockTask = navigator.locks.request('plato:auth-session', () => new Promise(resolve => {
          window.releaseAuthLock = resolve;
        }));
      });
      await a.waitForFunction(() => window.releaseAuthLock);
      await b.evaluate(() => { window.signingOut = window.authHarness.logout(); });
      await a.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'plato:auth-session'), null, { timeout: 3000 });
      assert.equal((await stored(a)).user.userId, 'x', 'credential removal waits for the shared lock');
      assert.equal(await b.evaluate(() => window.core.auth.authenticatedFetch('/v1/me').then(() => 'allowed', () => 'blocked')), 'blocked');
      await b.waitForFunction(() => window.authHarness.loggedIn === false);
      await a.evaluate(() => window.releaseAuthLock());
      await b.evaluate(() => window.signingOut);
      assert.equal(await stored(a), null);
    } finally { await a.evaluate(() => window.releaseAuthLock?.()).catch(() => {}); await context.close(); }
  });
  it('ignores stale event payloads and never publishes a malformed current record', async () => {
    const { context, a, b } = await pair();
    try {
      await login(a, 'x');
      await b.evaluate(() => localStorage.setItem('plato_auth', '{broken'));
      await a.waitForFunction(() => window.events.includes('plato_auth'));
      await a.evaluate(() => dispatchEvent(new StorageEvent('storage', { key: 'plato_auth', newValue: JSON.stringify({ accessToken: 'bad', user: { userId: 'bad', name: 'Malformed' } }) })));
      assert.equal(await a.evaluate(() => window.publishedUsers.includes('Malformed')), false);
      assert.equal(await a.evaluate(() => window.core.auth.captureAuthSession()), null);
    } finally { await context.close(); }
  });
});
