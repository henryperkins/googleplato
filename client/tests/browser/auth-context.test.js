import { browserEvidence } from './evidence.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
let browser, server, base;
browserEvidence('auth-context');
const root = fileURLToPath(new URL('../../..', import.meta.url));
async function open() {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const session = id => ({ accessToken: `access-${id}`, refreshToken: `refresh-${id}`, provider: 'password', user: { userId: id, name: `Account ${id}`, role: 'admin' } });
    if (!sessionStorage.getItem('auth-harness-initialized')) {
      localStorage.setItem('plato_auth', JSON.stringify(session('a')));
      sessionStorage.setItem('plato_impersonation', JSON.stringify({ userId: 'target' }));
      sessionStorage.setItem('auth-harness-initialized', 'true');
    }
    window.fetch = async (url, options) => {
      if (url.startsWith('/v1/me')) return { ok: true, status: 200, json: () => new Promise(resolve => { window.resolveProfile = resolve; }) };
      return new Response(JSON.stringify(url === '/v1/auth/login' ? session(JSON.parse(options.body).email) : {}), { status: 200 });
    };
  });
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/fixtures/auth-context.html`);
  await page.waitForFunction(() => window.resolveProfile && window.authHarness?.user?.userId === 'a');
  return { context, page };
}

describe('AuthContext session publication', { timeout: 120000 }, () => {
  before(async () => {
    const reservation = createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: `${root}/client`, stdio: 'pipe' });
    let output = '';
    server.stderr.on('data', chunk => { output += chunk; });
    for (let i = 0; ; i++) {
      assert.equal(server.exitCode, null, output);
      try { if ((await fetch(base)).ok) break; } catch { /* wait for owned Vite */ }
      assert.ok(i < 100, output); await delay(100);
    }
    browser = await chromium.launch();
  });
  after(async () => { await browser?.close(); if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await done; } });

  for (const name of ['QuotaExceededError', 'SecurityError']) {
    it(`failed external adoption keeps React and storage on the previous account after ${name}`, async () => {
      const { context, page } = await open();
      try {
        const result = await page.evaluate(async name => {
          const previous = localStorage.getItem('plato_auth');
          const write = Storage.prototype.setItem;
          const serve = window.fetch;
          const revoked = [];
          window.fetch = async (url, options) => {
            if (url === '/v1/auth/logout') revoked.push(JSON.parse(options.body).refreshToken);
            return serve(url, options);
          };
          Storage.prototype.setItem = function(key, value) {
            if (key === 'plato_auth') throw new DOMException('Storage refused', name);
            return write.call(this, key, value);
          };
          let code;
          try {
            await window.authHarness.adoptExternalSession({ accessToken: 'access-b', refreshToken: 'refresh-b',
              user: { userId: 'b', name: 'B', role: 'learner' } }, 'google-auth');
          } catch (error) { code = error.code; }
          finally { Storage.prototype.setItem = write; }
          return { code, previous, stored: localStorage.getItem('plato_auth'), revoked };
        }, name);
        assert.equal(result.code, 'auth_storage_unavailable');
        assert.equal(result.stored, result.previous);
        assert.deepEqual(result.revoked, ['refresh-b']);
        await page.waitForFunction(() => window.authHarness.user?.userId === 'a');
        assert.equal(await page.evaluate(() => window.publishedUsers.includes('B')), false);
      } finally { await context.close(); }
    });
  }

  for (const record of [{ accessToken: 'stale' }, { accessToken: 'a', refreshToken: 'r', user: null },
    { accessToken: 'a', refreshToken: 42, user: { userId: 'a' } }, {}]) {
    it(`settles malformed initial auth ${JSON.stringify(record)} into a usable signed-out state`, async () => {
      const context = await browser.newContext();
      await context.addInitScript(record => {
        localStorage.setItem('plato_auth', JSON.stringify(record));
        localStorage.setItem('plato_auth_attempt', '{"attemptId":42}');
        sessionStorage.setItem('plato_compose_draft_v2:a:lesson', 'Keep this draft');
        window.fetch = async () => Response.json({});
      }, record);
      const page = await context.newPage();
      try {
        await page.goto(`${base}/tests/browser/fixtures/auth-context.html`);
        await page.waitForFunction(() => window.authHarness && !window.authHarness.loading, null, { timeout: 1500 });
        assert.deepEqual(await page.evaluate(() => ({ loggedIn: window.authHarness.loggedIn,
          user: window.authHarness.user, stored: localStorage.getItem('plato_auth'),
          intent: localStorage.getItem('plato_auth_attempt'), draft: sessionStorage.getItem('plato_compose_draft_v2:a:lesson') })),
        { loggedIn: false, user: null, stored: null, intent: null, draft: 'Keep this draft' });
      } finally { await context.close(); }
    });
  }

  for (const transition of ['switch', 'logout', 'relogin']) {
    it(`does not publish a delayed profile after ${transition}`, async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(async transition => {
          await window.authHarness.logout();
          if (transition !== 'logout') await window.authHarness.login(transition === 'switch' ? 'b' : 'a', 'test');
          window.resolveProfile({ userId: 'a', name: 'Stale A', role: 'admin' });
        }, transition);
        await page.waitForTimeout(30);
        assert.equal(await page.evaluate(() => window.publishedUsers.includes('Stale A')), false);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('plato_auth'))?.user?.name || null), transition === 'logout' ? null : `Account ${transition === 'switch' ? 'b' : 'a'}`);
      } finally { await context.close(); }
    });
  }
  it('does not let cached refreshUser publish over a newer login', async () => {
    const { context, page } = await open();
    try {
      await page.evaluate(async () => {
        const oldRefresh = window.authHarness.refreshUser();
        await window.authHarness.logout();
        await window.authHarness.login('b', 'test');
        await oldRefresh;
        window.resolveProfile({ userId: 'a', name: 'Stale A', role: 'admin' });
      });
      await page.waitForFunction(() => window.authHarness?.user?.userId === 'b');
      assert.equal(await page.evaluate(() => window.authHarness.user.name), 'Account b');
      assert.equal(await page.evaluate(() => window.publishedUsers.includes('Stale A')), false);
    } finally { await context.close(); }
  });
  it('adopts an external session only while its starting generation is current', async () => {
    const { context, page } = await open();
    try {
      const result = await page.evaluate(async () => {
        let completions = 0;
        const guarded = window.authHarness.createPublicAuthSessionGuard()(
          { id: 'google-auth' },
          { onSession: async (session, provider, attemptId) => {
            completions += 1;
            await window.authHarness.adoptExternalSession(session, provider, attemptId);
          } },
        );
        await guarded.beforeStart();
        await guarded.onSession({
          accessToken: 'access-external', refreshToken: 'refresh-external',
          user: { userId: 'external', name: 'External learner', role: 'learner' },
        }, 'google-auth');
        return { completions, stored: JSON.parse(localStorage.getItem('plato_auth')) };
      });
      assert.equal(result.completions, 1);
      assert.equal(result.stored.user.userId, 'external');
      assert.equal(result.stored.provider, 'google-auth');
    } finally { await context.close(); }
  });

  it('a password login that finishes after an external sign-in leaves storage and React on the external account', async () => {
    const { context, page } = await open();
    try {
      const result = await page.evaluate(async () => {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const serve = window.fetch;
        window.fetch = async (url, options) => {
          if (url === '/v1/auth/login') await held;
          return serve(url, options);
        };
        const older = window.authHarness.login('slow', 'test').then(() => null, error => error.code);
        await window.authHarness.adoptExternalSession({
          accessToken: 'access-external', refreshToken: 'refresh-external',
          user: { userId: 'external', name: 'External learner', role: 'learner' },
        }, 'google-auth');
        release();
        return { code: await older, stored: JSON.parse(localStorage.getItem('plato_auth')) };
      });
      assert.equal(result.code, 'stale_auth_exchange');
      assert.deepEqual([result.stored.user.userId, result.stored.accessToken, result.stored.provider], ['external', 'access-external', 'google-auth']);
      await page.waitForFunction(() => window.authHarness?.user?.userId === 'external');
      assert.equal(await page.evaluate(() => window.publishedUsers.includes('Account slow')), false);
    } finally { await context.close(); }
  });

  for (const transition of ['switch', 'logout', 'relogin']) {
    it(`does not adopt a delayed external session after ${transition}`, async () => {
      const { context, page } = await open();
      try {
        const result = await page.evaluate(async transition => {
          let completions = 0;
          const guarded = window.authHarness.createPublicAuthSessionGuard()(
            { id: 'google-auth' },
            { onSession: async (session, provider, attemptId) => {
              completions += 1;
              await window.authHarness.adoptExternalSession(session, provider, attemptId);
            } },
          );
          await guarded.beforeStart();
          await window.authHarness.logout();
          if (transition !== 'logout') await window.authHarness.login(transition === 'switch' ? 'b' : 'a', 'test');
          const code = await guarded.onSession({
            accessToken: 'access-stale', refreshToken: 'refresh-stale',
            user: { userId: 'stale', name: 'Stale provider', role: 'learner' },
          }, 'google-auth').then(() => null, error => error.code);
          return { code, completions, stored: JSON.parse(localStorage.getItem('plato_auth')) };
        }, transition);
        assert.equal(result.code, 'stale_auth_exchange');
        assert.equal(result.completions, 0, 'stale completion must not publish or navigate');
        assert.equal(result.stored?.user?.userId || null, transition === 'logout' ? null : transition === 'switch' ? 'b' : 'a');
        assert.notEqual(result.stored?.accessToken, 'access-stale');
      } finally { await context.close(); }
    });
  }

  it('cannot start impersonation from a body belonging to a previous login', async () => {
    const { context, page } = await open();
    try {
      await page.evaluate(() => {
        const fetch = window.fetch;
        window.fetch = async (url, options) => url === '/v1/admin/impersonation/start'
          ? { ok: true, status: 200, json: () => new Promise(resolve => { window.resolveImpersonation = resolve; }) }
          : fetch(url, options);
        window.oldImpersonation = window.authHarness.startImpersonation('target').catch(error => error.message);
      });
      await page.waitForFunction(() => window.resolveImpersonation);
      await page.evaluate(async () => {
        await window.authHarness.logout();
        await window.authHarness.login('b', 'test');
        window.resolveImpersonation({ userId: 'target', name: 'Old target' });
      });
      assert.match(await page.evaluate(() => window.oldImpersonation), /account changed/);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('plato_impersonation')), null);
    } finally { await context.close(); }
  });
  it('clears impersonation after a same-session role demotion', async () => {
    const { context, page } = await open();
    try {
      await page.route('**/lessons', route => route.fulfill({ contentType: 'text/html', body: '<main>Own classroom reloaded</main>' }));
      await page.evaluate(() => window.resolveProfile({ userId: 'a', name: 'Educator A', role: 'educator' }));
      await page.waitForURL('**/lessons');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('plato_impersonation')), null);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('plato_auth')).user.role), 'educator');
    } finally { await context.close(); }
  });
});
