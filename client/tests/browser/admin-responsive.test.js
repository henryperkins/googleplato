import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const browserName = process.env.PLATO_TEST_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
assert.ok(browserType, `Unsupported PLATO_TEST_BROWSER: ${browserName}`);
const destinations = ['Home', 'Lessons', 'Users', 'Customizer', 'AI Settings', 'Notifications', 'Plugins'];
let browser;
let server;
let directory;
let base;
let storageState;

async function openPage(viewport, theme = 'light') {
  const context = await browser.newContext({ viewport, storageState });
  await context.addInitScript(value => localStorage.setItem('plato_theme', value), theme);
  const page = await context.newPage();
  return { context, page };
}

// The menu hands focus back to its trigger only after it finishes closing. Wait
// for that, as a keyboard user would: an activation that lands sooner has its
// focus moved back to the trigger and can't assert where focus stays.
async function closeMenuWithEscape(page, trigger) {
  const handle = await trigger.elementHandle();
  await page.keyboard.press('Escape');
  await page.waitForFunction(el => document.activeElement === el && el.getAttribute('aria-expanded') === 'false', handle);
}

async function filterWaitlist(page) {
  const trigger = page.getByRole('button', { name: /^Filters/ });
  await trigger.click();
  await page.getByRole('menu').getByRole('group', { name: 'Status', exact: true }).getByRole('menuitemcheckbox', { name: /^Wait list/ }).click();
  await closeMenuWithEscape(page, trigger);
}

async function navigate(page, section) {
  await page.goto(`${base}/plato/${section}`);
  await page.locator('#main-content h1').waitFor();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}

async function tabGeometry(page) {
  return page.locator('.admin-bottom-nav').evaluate(nav => Array.from(nav.querySelectorAll('a'), link => {
    const label = link.querySelector('span');
    const style = getComputedStyle(label);
    const text = document.createRange();
    text.selectNodeContents(label);
    return {
      name: label.textContent.trim(),
      visible: style.position !== 'absolute' && style.display !== 'none'
        && style.visibility !== 'hidden' && label.getClientRects().length > 0,
      target: link.getBoundingClientRect().toJSON(),
      text: Array.from(text.getClientRects(), rect => rect.toJSON()),
    };
  }));
}

async function controlAiSettings(context, overrides = {}) {
  const oauthDefaults = { available: true, connected: false, needsReconnect: false, connectionPending: false, revocationPending: false,
    version: 0, account: null, pendingAccounts: [], pendingFlowId: null };
  let saved = {
    provider: 'workers-ai', workersAiModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    bedrockModel: 'qwen3-vl-235b', awsRegion: 'us-east-2', version: 4,
    bedrockCredentials: { configured: false },
    workersAiModels: [
      { id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017' },
      { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B' },
    ],
    workersAiCredentials: { configured: true, source: 'oauth', accountId: true, apiToken: true },
    workersAiOAuth: { available: true, connected: true, version: 1, account: { name: 'Learning Studio' } },
    ...overrides,
  };
  if (saved.workersAiOAuth) saved.workersAiOAuth = { ...oauthDefaults, ...saved.workersAiOAuth };
  const requests = [];
  await context.route('**/v1/admin/ai-settings**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/test')) {
      const candidate = request.postDataJSON();
      requests.push({ action: 'test', ...candidate });
      await route.fulfill({ json: { ok: true, provider: candidate.provider, model: candidate.workersAiModel } });
    } else if (request.method() === 'PUT') {
      const candidate = request.postDataJSON();
      requests.push({ action: 'save', ...candidate });
      saved = { ...saved, ...candidate, version: saved.version + 1 };
      await route.fulfill({ json: saved });
    } else if (request.method() === 'GET') {
      await route.fulfill({ json: saved });
    } else {
      await route.fulfill({ status: 503, json: { error: 'No external connection is made by this fixture.' } });
    }
  });
  return {
    requests,
    update: changes => {
      saved = { ...saved, ...changes };
      if (changes.workersAiOAuth) saved.workersAiOAuth = { ...oauthDefaults, ...changes.workersAiOAuth };
    },
    snapshot: () => structuredClone(saved),
  };
}

async function controlUsers(context, count = 4) {
  const users = Array.from({ length: count }, (_, i) => ({
    userId: `mobile-user-${i}`, name: i === 0 ? 'Avery North' : `Learner ${String(i).padStart(2, '0')}`,
    firstName: i === 0 ? 'Avery North' : `Learner ${String(i).padStart(2, '0')}`, lastName: '',
    email: i === 1 ? `${'long-address.'.repeat(5)}@example.test` : `learner${i}@example.test`,
    username: `learner${i}`, role: 'user', userGroup: 'Autumn cohort',
    createdAt: '2026-10-01T12:00:00Z', lessonsCompleted: i, lessonsAvailable: 30,
    lastActiveAt: null, customFields: { team: 'Design' },
  }));
  const invites = [{ inviteToken: 'mobile-invite', email: 'invited@example.test', status: 'pending', createdAt: '2026-10-02T12:00:00Z' }];
  const entries = [{ inviteToken: 'mobile-wait', name: 'Zoe West', email: 'zoe@example.test', createdAt: '2026-10-03T14:35:00Z' }];
  await context.route('**/v1/admin/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.fulfill({ status: 503, json: { error: 'Simulated request failure. Try again.' } });
    let data = {};
    if (path === '/v1/admin/users') data = users;
    else if (path.endsWith('/stats')) data = { lessonsCompleted: 0, lessonsAvailable: 30, lessonDurations: [] };
    else if (path === '/v1/admin/invites') data = invites;
    else if (path === '/v1/admin/invites/link') data = null;
    else if (path === '/v1/admin/waitlist') data = { entries, open: true, hasApiKey: false };
    else if (path === '/v1/admin/plugins') data = [];
    else if (path === '/v1/admin/settings') data = {
      userGroups: ['Autumn cohort'], userFields: [{ id: 'team', label: 'Team', type: 'dropdown', options: ['Design', 'Operations'] }],
    };
    return route.fulfill({ json: data });
  });
  return { users, entries, invites };
}

// The timeout covers the whole suite. Cloud Build ran its 24 tests in 89 of the
// former 90 seconds (build 6bf6dd9a, 2026-11-05), so leave room for growth.
describe('Rendered admin responsive regressions', { timeout: 180000 }, () => {
  before(async () => {
    assert.ok(existsSync(join(root, 'client/dist/index.html')), 'Run npm run build:client before browser tests');
    directory = await mkdtemp(join(tmpdir(), 'plato-admin-responsive-'));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    base = `http://127.0.0.1:${port}`;
    const email = 'responsive@plato.test';
    const password = randomBytes(24).toString('base64url');
    server = spawn(process.execPath, ['dev-sqlite.js'], {
      cwd: join(root, 'server'),
      env: {
        ...process.env,
        PORT: String(port),
        SQLITE_PATH: join(directory, 'test.sqlite'),
        APP_URL: base,
        JWT_SECRET: randomBytes(32).toString('hex'),
        ADMIN_EMAIL: email,
        ADMIN_PASSWORD: password,
        SKIP_EMAIL: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-10000); };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
    const started = Date.now();
    while (true) {
      assert.equal(server.exitCode, null, `Test server stopped: ${output}`);
      try {
        const response = await fetch(`${base}/v1/auth/setup-status`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch { /* Wait for the owned local test server to start. */ }
      assert.ok(Date.now() - started < 15000, `Test server did not start: ${output}`);
      await delay(100);
    }
    browser = await browserType.launch({ executablePath: process.env.PLATO_TEST_BROWSER_EXECUTABLE || undefined });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${base}/plato`);
      await page.getByLabel('Email or Username', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL(url => !url.pathname.startsWith('/login'));
      await page.locator('#main-content').waitFor();
      storageState = await context.storageState();
    } finally {
      await context.close();
    }
  });

  after(async () => {
    await browser?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 3000);
      force.unref();
      try { await exited; } finally { clearTimeout(force); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('registers the injected hosting worker at root on fresh and warm nested entries', async () => {
    const proxy = createHttpServer(async (request, response) => {
      if (request.url === '/_service-worker.js') {
        response.writeHead(200, { 'Content-Type': 'application/javascript' });
        response.end("self.addEventListener('install', event => event.waitUntil(self.skipWaiting())); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));");
        return;
      }
      try {
        const upstream = await fetch(`${base}${request.url}`);
        let body = Buffer.from(await upstream.arrayBuffer());
        const type = upstream.headers.get('content-type') || 'application/octet-stream';
        if (type.includes('text/html')) {
          body = Buffer.from(body.toString().replace('</head>', `<script>
            window.addEventListener('load', () => navigator.serviceWorker.register('./_service-worker.js')
              .then(() => { window.hostingWorkerStatus = 'registered'; })
              .catch(error => { window.hostingWorkerStatus = error.message; }));
          </script></head>`));
        }
        response.writeHead(upstream.status, { 'Content-Type': type });
        response.end(body);
      } catch {
        response.writeHead(502);
        response.end('Fixture proxy failed');
      }
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    try {
      for (const path of ['/plato/customizer', '/plato/customizer/']) {
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          for (const entry of [path, '/login', path]) {
            await page.goto(`${origin}${entry}`);
            await page.waitForFunction(() => window.hostingWorkerStatus);
            assert.equal(await page.evaluate(() => window.hostingWorkerStatus), 'registered');
            assert.deepEqual(await page.evaluate(async () => {
              const registration = await navigator.serviceWorker.ready;
              return { scope: registration.scope, script: registration.active.scriptURL };
            }), { scope: `${origin}/`, script: `${origin}/_service-worker.js` });
          }
        } finally { await context.close(); }
      }
    } finally { await new Promise(resolve => proxy.close(resolve)); }
  });

  it('announces sign-in after a protected redirect without announcing the inaccessible page', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.navigationAnnouncements = [];
      new MutationObserver(() => {
        for (const element of document.querySelectorAll('[role="status"]')) {
          if (element.textContent.startsWith('Navigated to ')) window.navigationAnnouncements.push(element.textContent);
        }
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      await page.goto(`${base}/plato/customizer`);
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      await page.getByRole('status').filter({ hasText: /^Navigated to Sign in$/ }).waitFor();
      assert.ok(!(await page.evaluate(() => window.navigationAnnouncements)).includes('Navigated to Classroom Customizer'));
      await page.getByRole('link', { name: 'Forgot password?', exact: true }).click();
      await page.getByRole('heading', { name: 'Reset password', exact: true }).waitFor();
      await page.getByRole('status').filter({ hasText: /^Navigated to Reset password$/ }).waitFor();
      assert.match(await page.title(), /^Reset password — /);
    } finally { await context.close(); }
  });

  it('clears the previous announcement while a lesson destination is unresolved', async () => {
    const { context, page } = await openPage({ width: 1280, height: 900 });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await context.route('**/v1/sync', async route => { await pending; await route.continue().catch(() => {}); });
    page.setDefaultTimeout(8000);
    try {
      await page.goto(`${base}/plato/customizer`);
      await page.getByRole('status').filter({ hasText: /^Navigated to Classroom Customizer$/ }).waitFor();
      // A popstate transition exercises the same mounted announcer while the
      // catalog is held, without creating or modifying a learner's lessons.
      await page.evaluate(() => {
        history.pushState(history.state, '', '/lessons/unresolved-title');
        dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.waitForFunction(() => location.pathname === '/lessons/unresolved-title'
        && document.title.startsWith('Lesson — ')
        && !Array.from(document.querySelectorAll('[role="status"]')).some(element => element.textContent.startsWith('Navigated to ')));
    } finally { release(); await context.close(); }
  });

  it('preserves lesson shares through a public/private round trip', async () => {
    for (const width of [320, 1280]) {
      const { context, page } = await openPage({ width, height: 844 });
      try {
        const sharedWith = ['share-avery', 'share-blair'];
        let lesson = { lessonId: 'share-regression', name: 'Sharing Regression', status: 'private', sharedWith: [...sharedWith] };
        await context.route('**/v1/admin/**', async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (path === '/v1/admin/lessons/share-regression' && request.method() === 'PUT') {
            lesson = { ...lesson, ...request.postDataJSON() };
            return route.fulfill({ json: { ok: true } });
          }
          if (request.method() !== 'GET') return route.fallback();
          if (path === '/v1/admin/lessons') return route.fulfill({ json: [lesson] });
          if (path === '/v1/admin/courses') return route.fulfill({ json: [] });
          if (path === '/v1/admin/stats/lessons') return route.fulfill({ json: { byLesson: {} } });
          if (path === '/v1/admin/users') return route.fulfill({ json: [
            { userId: 'share-avery', name: 'Avery North', email: 'avery@example.test', role: 'user' },
            { userId: 'share-blair', name: 'Blair West', email: 'blair@example.test', role: 'user' },
          ] });
          return route.fallback();
        });

        await navigate(page, 'lessons');
        const shareButton = page.getByRole('button', { name: /^Visibility and sharing for Sharing Regression:/ });
        await shareButton.click();
        const dialog = page.getByRole('dialog', { name: 'Visibility & Sharing' });
        await dialog.getByRole('radio', { name: 'Public', exact: true }).focus();
        await page.keyboard.press('Space');
        await dialog.getByRole('button', { name: 'Make public', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(lesson.status, 'public');
        assert.deepEqual(lesson.sharedWith, sharedWith, 'making a lesson public must retain its share list');

        await page.reload();
        await shareButton.click();
        await dialog.getByRole('radio', { name: 'Private', exact: true }).focus();
        await page.keyboard.press('Space');
        assert.equal(await dialog.getByRole('checkbox', { name: 'Share with Avery North', exact: true }).isChecked(), true);
        assert.equal(await dialog.getByRole('checkbox', { name: 'Share with Blair West', exact: true }).isChecked(), true);
        const confirm = dialog.getByRole('button', { name: 'Share with 2 users', exact: true });
        assert.equal(await confirm.isEnabled(), true);
        await confirm.click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(lesson.status, 'private');
        assert.deepEqual(lesson.sharedWith, sharedWith);
      } finally {
        await context.close();
      }
    }
  });

  it('downloads the full searched and sorted user list from mobile and desktop', async () => {
    for (const width of [320, 1280]) {
      const { context, page } = await openPage({ width, height: 844 });
      try {
        const { users } = await controlUsers(context, 25);
        users[0].email = 'avery@example.test';
        users[0].username = 'avery';
        await navigate(page, 'users');
        await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('Learner ');
        if (width < 768) {
          await page.getByRole('button', { name: 'Filter & sort', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Filter & sort', exact: true });
          await dialog.getByLabel('Order', { exact: true }).selectOption('desc');
          await dialog.getByRole('button', { name: 'Show 24 people', exact: true }).click();
        } else {
          await page.getByRole('columnheader', { name: 'User', exact: true }).getByRole('button').click();
        }
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await page.getByText('Page 2 of 2', { exact: true }).waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1);
        const downloadEvent = page.waitForEvent('download');
        const button = page.getByRole('button', { name: 'Download CSV user list', exact: true });
        await button.focus();
        await button.press('Enter');
        const download = await downloadEvent;
        assert.match(download.suggestedFilename(), /^plato-users-\d{4}-\d{2}-\d{2}\.csv$/);
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const csv = Buffer.concat(chunks).toString('utf8');
        assert.ok(csv.startsWith('\uFEFFEmail,First Name,Last Name,Username,Group,Role,Status,Date Added,Team,User ID\r\n'));
        const rows = csv.slice(1).split('\r\n').slice(1);
        assert.deepEqual(rows.map(row => row.split(',')[1]), Array.from({ length: 24 }, (_, i) => `Learner ${String(24 - i).padStart(2, '0')}`));
        assert.ok(rows.every(row => /,Design,mobile-user-\d+$/.test(row)), 'Custom fields remain in the export');
      } finally { await context.close(); }
    }
  });

  it('keeps mobile people, details, actions and pagination usable without sideways scrolling', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState, hasTouch: true, isMobile: true });
    try {
      await controlUsers(context, 25);
      const page = await context.newPage();
      await navigate(page, 'users');
      for (const width of [320, 390, 640]) {
        await page.setViewportSize({ width, height: 844 });
        await page.getByRole('list', { name: 'Users and invites', exact: true }).waitFor();
        const box = await page.getByRole('button', { name: 'Invite Users', exact: true }).boundingBox();
        const nav = await page.getByRole('navigation', { name: 'Admin navigation' }).boundingBox();
        assert.ok(box.y > 422 && box.y + box.height <= nav.y + 1, 'Invite stays within thumb reach above navigation');
        assert.ok(box.height >= 44, 'Primary action has a touch-sized target');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollHeight) <= 845, 'The directory scrolls inside the shell, without a blank document tail');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit Avery North', exact: true }) });
      await row.locator('summary').tap();
      await row.getByText('Autumn cohort', { exact: true }).waitFor();
      await row.getByText('Never', { exact: true }).waitFor();
      await row.getByText('0 of 30 lessons completed', { exact: true }).waitFor();
      await row.locator('dl').getByText('Lesson scope', { exact: true }).waitFor();
      await row.locator('dl').getByText('All published lessons.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await page.getByText('Page 2 of 2', { exact: true }).waitFor();
      await filterWaitlist(page);
      await page.getByRole('button', { name: 'Invite zoe@example.test', exact: true }).waitFor();
      assert.equal(await page.getByRole('navigation', { name: 'Pagination', exact: true }).count(), 0, 'A filter resets pagination to its first page');
      await page.getByRole('button', { name: 'Edit wait list entry for Zoe West', exact: true }).click();
      await page.getByRole('heading', { name: 'Edit Wait List Entry', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Edit Wait List Entry');
      await page.getByRole('button', { name: 'Remove from wait list', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Simulated request failure. Try again.' }).waitFor();
      await page.getByLabel('Email', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Edit wait list entry for Zoe West');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('region', { name: 'Users and invites', exact: true }).waitFor();
      assert.equal(await page.getByRole('list', { name: 'Users and invites', exact: true }).count(), 0, 'Only one directory presentation is mounted');
      await page.getByRole('button', { name: 'Date added', exact: false }).click();
      assert.equal(await page.getByRole('columnheader', { name: 'Date added', exact: false }).getAttribute('aria-sort'), 'ascending');
    } finally { await context.close(); }
  });

  it('recovers from an empty custom-field filter and preserves sorting through the mobile sheet', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    try {
      await controlUsers(context);
      await navigate(page, 'users');
      const filters = page.getByRole('button', { name: /^Filters/ });
      await filters.click();
      await page.getByRole('menu').getByRole('group', { name: 'Team' }).getByRole('menuitemcheckbox', { name: /^Operations/ }).click();
      await closeMenuWithEscape(page, filters);
      const dialog = page.getByRole('dialog', { name: 'Filter & sort', exact: true });
      await page.getByText('No users match these filters.', { exact: true }).waitFor();
      assert.equal(await page.getByText('No users yet.', { exact: false }).count(), 0);
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'users-search');
      assert.equal(await page.getByRole('list', { name: 'Users and invites' }).getByRole('listitem').count(), 6);
      await page.getByRole('button', { name: 'Filter & sort', exact: true }).click();
      await dialog.getByLabel('Order', { exact: true }).selectOption('desc');
      await dialog.getByRole('button', { name: 'Show 6 people', exact: true }).click();
      const first = page.getByRole('list', { name: 'Users and invites' }).getByRole('listitem').first();
      await first.getByRole('button', { name: 'Edit wait list entry for Zoe West', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Filter & sort');
    } finally { await context.close(); }
  });

  it('keeps account saving focusable, rejects duplicate activation and restores the edited row', async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await openPage({ width, height: 900 });
      let release;
      const response = new Promise(resolve => { release = resolve; });
      try {
        const fixture = await controlUsers(context);
        let requests = 0;
        await context.route('**/v1/admin/users/mobile-user-0', async route => {
          requests++;
          const changes = route.request().postDataJSON();
          await response;
          Object.assign(fixture.users[0], changes, { name: [changes.firstName, changes.lastName].filter(Boolean).join(' ') });
          await route.fulfill({ json: fixture.users[0] });
        });
        await navigate(page, 'users');
        await page.getByRole('button', { name: 'Edit Avery North', exact: true }).press('Enter');
        await page.getByRole('heading', { name: 'Edit User', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H1');
        await page.getByLabel('First name', { exact: true }).fill('Avery Updated');
        await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
        const pending = page.getByRole('button', { name: 'Saving…', exact: true });
        await pending.waitFor();
        assert.equal(await pending.getAttribute('aria-disabled'), 'true');
        assert.equal(await pending.evaluate(el => el === document.activeElement), true);
        assert.equal(await page.getByLabel('First name', { exact: true }).isDisabled(), true);
        await pending.press('Enter');
        assert.equal(requests, 1, 'Only one write is sent while saving');
        release();
        await page.getByRole('button', { name: 'Edit Avery Updated', exact: true }).waitFor();
        await page.getByRole('status').filter({ hasText: 'User updated.' }).waitFor();
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Edit Avery Updated');
      } finally { release(); await context.close(); }
    }
  });

  it('shows failed invitations inside the sheet and preserves focus and the queue for retry', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    let release;
    const response = new Promise(resolve => { release = resolve; });
    try {
      await controlUsers(context);
      let requests = 0;
      await context.route('**/v1/admin/invites/bulk', async route => {
        requests++;
        await response;
        await route.fulfill(requests === 1
          ? { status: 503, json: { error: 'Invitations are unavailable. Try again.' } }
          : { json: { sent: 1, skipped: 0, failed: 0, links: [] } });
      });
      await navigate(page, 'users');
      await page.getByRole('button', { name: 'Invite Users', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Invite Users', exact: true });
      await dialog.getByLabel('Email(s)', { exact: true }).fill('new@example.test');
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await dialog.getByRole('button', { name: 'Send 1 invite', exact: true }).press('Enter');
      const pending = dialog.getByRole('button', { name: 'Sending…', exact: true });
      await pending.waitFor();
      assert.equal(await pending.evaluate(el => el === document.activeElement), true);
      await pending.press('Enter');
      assert.equal(requests, 1);
      release();
      await dialog.getByRole('alert').filter({ hasText: 'Invitations are unavailable. Try again.' }).waitFor();
      const retry = dialog.getByRole('button', { name: 'Send 1 invite', exact: true });
      assert.equal(await retry.evaluate(el => el === document.activeElement), true);
      await dialog.getByRole('button', { name: 'Remove new@example.test', exact: true }).waitFor();
      await retry.press('Enter');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(requests, 2);
      assert.equal(await page.getByRole('button', { name: 'Invite Users', exact: true }).evaluate(el => el === document.activeElement), true);
    } finally { release(); await context.close(); }
  });

  it('supports touch sheet dismissal and reduces movement when requested', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState, hasTouch: true, isMobile: true });
    try {
      await controlUsers(context);
      const page = await context.newPage();
      await navigate(page, 'users');
      await page.getByRole('button', { name: 'Filter & sort', exact: true }).tap();
      const sheet = page.getByRole('dialog', { name: 'Filter & sort', exact: true });
      assert.equal(await sheet.evaluate(el => getComputedStyle(el).animationName), 'users-sheet-arrive');
      await page.waitForTimeout(250);
      const handle = await sheet.locator('[data-slot="sheet-handle"]').boundingBox();
      const cdp = await context.newCDPSession(page);
      const point = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      // A real swipe has intermediate frames; teleporting the touch point can
      // leave Chromium's synthetic gesture recognizer suppressing the next tap.
      for (let step = 1; step <= 7; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + step * 20 }] });
        await page.waitForTimeout(30);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sheet.waitFor({ state: 'hidden' });
      // Allow Chromium's post-swipe click suppression to settle before a new gesture.
      await page.waitForTimeout(400);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.getByRole('button', { name: 'Filter & sort', exact: true }).tap();
      assert.equal(await sheet.evaluate(el => getComputedStyle(el).animationName), 'users-feedback-arrive');
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'hidden' });
      const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit Avery North', exact: true }) });
      await row.locator('summary').tap();
      assert.equal(await row.locator('.users-detail-chevron').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
      await page.setViewportSize({ width: 844, height: 390 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 844, 'Landscape remains usable');
    } finally { await context.close(); }
  });

  it('keeps focus in the directory when inviting removes the active wait-list row', async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await openPage({ width, height: 844 });
      let release;
      const response = new Promise(resolve => { release = resolve; });
      try {
        const fixture = await controlUsers(context);
        let requests = 0;
        await context.route('**/v1/admin/waitlist/mobile-wait/invite', async route => {
          requests++;
          await response;
          fixture.entries.length = 0;
          fixture.invites.push({ inviteToken: 'mobile-wait', email: 'zoe@example.test', status: 'pending', createdAt: '2026-10-26T12:00:00Z' });
          await route.fulfill({ json: { sent: true } });
        });
        await navigate(page, 'users');
        await filterWaitlist(page);
        const invite = page.getByRole('button', { name: 'Invite zoe@example.test', exact: true });
        await invite.press('Enter');
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-disabled') === 'true');
        await invite.press('Enter');
        assert.equal(requests, 1);
        release();
        await page.getByText('No users match these filters.', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Users');
      } finally { release(); await context.close(); }
    }
  });

  it('says when a group delete left people behind and finishes it from the dialog', async () => {
    const { context, page } = await openPage({ width: 1280, height: 844 });
    try {
      await controlUsers(context);
      const deletes = [];
      await context.route('**/v1/admin/groups/**', async route => {
        if (route.request().method() !== 'DELETE') return route.fallback();
        deletes.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()));
        const failed = deletes.length === 1 ? 1 : 0;
        await route.fulfill({ json: { userGroups: [], moved: { users: failed ? 3 : 1, invites: 0, messages: 0, failed } } });
      });
      await navigate(page, 'users');
      await page.getByRole('button', { name: 'Manage', exact: true }).click();
      await page.getByRole('menuitem', { name: 'User Groups', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'User Groups' });
      await dialog.getByRole('button', { name: 'Delete group Autumn cohort', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete group', exact: true }).click();
      const status = dialog.getByRole('status');
      await status.filter({ hasText: 'Deleted Autumn cohort.' }).waitFor();
      assert.equal(await status.textContent(), 'Deleted Autumn cohort. 1 person couldn’t be taken out of it yet.');
      const finish = dialog.getByRole('button', { name: 'Finish removing people from Autumn cohort', exact: true });
      await finish.click();
      await status.filter({ hasText: 'Nobody is in Autumn cohort any more.' }).waitFor();
      assert.equal(await finish.count(), 0);
      await page.waitForFunction(() => document.activeElement?.id === 'new-group-name');
      assert.deepEqual(deletes, ['Autumn cohort', 'Autumn cohort']);
    } finally { await context.close(); }
  });

  it('leaves focus where Tab or a quick activation moves it after a menu closes', async () => {
    const { context, page } = await openPage({ width: 1280, height: 844 });
    try {
      await controlUsers(context);
      await navigate(page, 'users');
      const trigger = page.getByRole('button', { name: /^Filters/ });
      const openByKeyboard = async () => {
        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitemcheckbox');
      };
      // The menu's `toggle` close handler is queued; aria-expanded turns false
      // when it runs. Tab must keep focus on the next control, not the trigger.
      await openByKeyboard();
      await page.keyboard.press('Tab');
      await page.waitForFunction(el => el.getAttribute('aria-expanded') === 'false', await trigger.elementHandle());
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Columns');

      // Escape returns focus to the trigger at once. A control activated before
      // the queued close event runs (assistive-tech macros can be that fast)
      // keeps its focus.
      await openByKeyboard();
      const focus = await page.evaluate(async () => {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const restored = document.activeElement.getAttribute('aria-label');
        document.getElementById('users-search').focus();
        await new Promise(resolve => setTimeout(resolve, 50));
        return { restored, after: document.activeElement.id };
      });
      assert.deepEqual(focus, { restored: 'Filters', after: 'users-search' });
    } finally { await context.close(); }
  });

  it('invites an existing account once and names only the action that is running', async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await openPage({ width, height: 844 });
      let releaseRemove;
      let releaseCopy;
      const removed = new Promise(resolve => { releaseRemove = resolve; });
      const copied = new Promise(resolve => { releaseCopy = resolve; });
      try {
        const fixture = await controlUsers(context);
        fixture.entries[0].alreadyRegistered = 'account';
        fixture.entries.push({ inviteToken: 'second-wait', name: 'Yuki East', email: 'yuki@example.test', createdAt: '2026-10-04T09:00:00Z' });
        let copies = 0;
        await context.route('**/v1/admin/waitlist/second-wait', async route => {
          await removed;
          fixture.entries.splice(fixture.entries.findIndex(entry => entry.inviteToken === 'second-wait'), 1);
          await route.fulfill({ json: { ok: true } });
        });
        await context.route('**/v1/admin/waitlist/mobile-wait/invite', async route => {
          copies++;
          await copied;
          fixture.entries.splice(fixture.entries.findIndex(entry => entry.inviteToken === 'mobile-wait'), 1);
          await route.fulfill({ json: { userId: 'mobile-user-0', userGroup: 'Autumn cohort', fields: ['team'] } });
        });
        await navigate(page, 'users');
        await filterWaitlist(page);

        // A removal holds the row without reading as an invite or a copy.
        const remove = page.getByRole('button', { name: 'Remove yuki@example.test from the wait list', exact: true });
        if (width < 768) await page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit wait list entry for Yuki East', exact: true }) }).locator('summary').click();
        await remove.click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
        const invite = page.getByRole('button', { name: 'Invite yuki@example.test', exact: true });
        await page.waitForFunction(() => document.querySelector('[aria-label="Invite yuki@example.test"]')?.getAttribute('aria-disabled') === 'true');
        assert.equal((await invite.textContent()).trim(), 'Invite', 'A removal does not read as sending an invite');
        if (width < 768) assert.equal((await remove.textContent()).trim(), 'Removing…');
        releaseRemove();
        await invite.waitFor({ state: 'detached' });

        // Invite is named by its visible label and runs once.
        const copy = page.getByRole('button', { name: 'Invite zoe@example.test', exact: true });
        assert.equal((await copy.textContent()).trim(), 'Invite');
        await copy.click();
        await page.waitForFunction(() => document.querySelector('[aria-label="Invite zoe@example.test"]')?.textContent.trim() === 'Sending…');
        assert.equal(await copy.getAttribute('aria-disabled'), 'true');
        await copy.press('Enter');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.getByRole('alertdialog').count(), 0, 'A running copy cannot be confirmed again');
        assert.equal(copies, 1);
        releaseCopy();
        await page.getByRole('status').filter({ hasText: 'Invite sent to zoe@example.test.' }).waitFor();
        await copy.waitFor({ state: 'detached' });
        assert.equal(copies, 1);
      } finally { releaseRemove(); releaseCopy(); await context.close(); }
    }
  });

  it('keeps a newer wait-list editor open when an earlier invite finishes', async () => {
    const { context, page } = await openPage({ width: 1280, height: 900 });
    let release;
    const response = new Promise(resolve => { release = resolve; });
    try {
      const fixture = await controlUsers(context);
      fixture.entries[0].alreadyRegistered = 'account';
      fixture.entries.push({ inviteToken: 'second-wait', name: 'Yuki East', email: 'yuki@example.test', createdAt: '2026-10-04T09:00:00Z' });
      let copies = 0;
      await context.route('**/v1/admin/waitlist/mobile-wait/invite', async route => {
        copies++;
        await response;
        fixture.entries.splice(fixture.entries.findIndex(entry => entry.inviteToken === 'mobile-wait'), 1);
        await route.fulfill({ json: { userId: 'mobile-user-0', userGroup: null, fields: ['team'] } });
      });
      await navigate(page, 'users');
      await filterWaitlist(page);
      await page.getByRole('button', { name: 'Edit wait list entry for Zoe West', exact: true }).click();
      await page.getByRole('heading', { name: 'Edit Wait List Entry', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Invite', exact: true }).click();
      await page.getByRole('button', { name: 'Sending…', exact: true }).waitFor();
      for (const name of ['Sending…', 'Save', 'Cancel', 'Back to users', 'Remove from wait list']) {
        assert.equal(await page.getByRole('button', { name, exact: true }).getAttribute('aria-disabled'), 'true', `${name} waits for the copy`);
      }
      assert.equal(await page.getByLabel('Email', { exact: true }).getAttribute('readonly'), '', 'Nothing typed during the copy can be lost');
      await page.getByRole('status').filter({ hasText: 'Sending invite…' }).waitFor();

      // Leave through browser history and open another entry before the copy lands.
      await page.goBack();
      await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
      assert.equal((await page.getByRole('button', { name: 'Invite zoe@example.test', exact: true }).textContent()).trim(), 'Sending…');
      await page.getByRole('button', { name: 'Edit wait list entry for Yuki East', exact: true }).click();
      await page.getByRole('heading', { name: 'Edit Wait List Entry', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'yuki@example.test');
      const refreshed = page.waitForResponse(res => new URL(res.url()).pathname === '/v1/admin/waitlist' && res.request().method() === 'GET');
      release();
      await refreshed;
      assert.equal(new URL(page.url()).pathname, '/plato/users/waitlist/second-wait', 'The finished copy leaves the newer editor open');
      assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'yuki@example.test');
      assert.equal(copies, 1);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Invite sent to zoe@example.test.' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Invite zoe@example.test', exact: true }).count(), 0);
    } finally { release(); await context.close(); }
  });

  it('shows readable waitlist timestamps in the viewer locale and timezone', async () => {
    const entries = [
      { inviteToken: 'waitlist-early', name: 'Avery North', email: 'avery@example.test', createdAt: '2026-10-26T01:35:07.000Z' },
      { inviteToken: 'waitlist-later', name: 'Blair West', email: 'blair@example.test', createdAt: '2026-10-26T15:05:42.000Z' },
    ];
    for (const { locale, timezoneId, expected } of [
      { locale: 'en-US', timezoneId: 'America/New_York', expected: ['10/25/2026, 9:35:07 PM', '10/26/2026, 11:05:42 AM'] },
      { locale: 'en-GB', timezoneId: 'Europe/London', expected: ['26/10/2026, 01:35:07', '26/10/2026, 15:05:42'] },
    ]) {
      const context = await browser.newContext({ viewport: { width: 320, height: 740 }, storageState, locale, timezoneId });
      try {
        await context.route('**/v1/admin/waitlist', route => route.fulfill({
          json: { entries, open: true, hasApiKey: false },
        }));
        const page = await context.newPage();
        await navigate(page, 'users');
        await filterWaitlist(page);
        for (const width of [320, 1280]) {
          await page.setViewportSize({ width, height: 740 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1, 'The page stays within the viewport');
          if (width === 320) {
            for (const [index, entry] of entries.entries()) {
              const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Edit wait list entry for ${entry.name}`, exact: true }) });
              const date = row.locator('time');
              assert.equal(await date.innerText(), expected[index]);
              const box = await date.boundingBox();
              assert.ok(box.x >= 0 && box.x + box.width <= width, 'Full waitlist time is readable without sideways scrolling');
            }
            continue;
          }
          await page.getByRole('region', { name: 'Users and invites', exact: true }).waitFor();
          for (const [index, entry] of entries.entries()) {
            const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: `Edit wait list entry for ${entry.name}`, exact: true }) });
            const date = row.getByRole('cell').nth(6);
            assert.equal((await date.innerText()).replace(/\s+/g, ' '), expected[index], `${locale}: local date and full time for ${entry.name}`);
            const geometry = await date.evaluate(cell => {
              cell.scrollIntoView({ block: 'nearest', inline: 'end' });
              const container = cell.closest('[role="region"]').getBoundingClientRect();
              const identity = cell.parentElement.querySelector('[scope="row"]').getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(cell);
              return {
                left: Math.max(container.left, identity.right),
                right: container.right,
                lines: Array.from(range.getClientRects(), rect => ({ left: rect.left, right: rect.right })),
              };
            });
            assert.ok(geometry.lines.length > 0, 'The timestamp has rendered text');
            for (const line of geometry.lines) {
              assert.ok(line.left >= geometry.left - 1 && line.right <= geometry.right + 1,
                `${locale} at ${width}px: timestamp must be readable beside the sticky user column`);
            }
          }
        }
      } finally {
        await context.close();
      }
    }
  });

  it('keeps AI Settings and Plugins inside short desktop windows at both breakpoints', async () => {
    for (const theme of ['light', 'dark']) {
      const { context, page } = await openPage({ width: 1024, height: 545 }, theme);
      try {
        for (const section of ['ai', 'plugins']) {
          await navigate(page, section);
          for (const [width, height] of [[1024, 545], [1024, 540], [1024, 360], [1023, 540]]) {
            await page.setViewportSize({ width, height });
            const bounds = await page.evaluate(() => ({
              documentWidth: document.documentElement.scrollWidth,
              mainRight: document.querySelector('#main-content').getBoundingClientRect().right,
            }));
            assert.ok(bounds.documentWidth <= width + 1, `${section} ${theme} ${width}×${height}: document is ${bounds.documentWidth}px wide`);
            assert.ok(bounds.mainRight <= width + 1, `${section}: main extends past the viewport`);
          }
        }
      } finally {
        await context.close();
      }
    }
  });

  it('keeps all seven enlarged-text labels visible and inside their own targets', async () => {
    for (const theme of ['light', 'dark']) {
      for (const width of [320, 390, 480, 768]) {
        const { context, page } = await openPage({ width, height: 900 }, theme);
        try {
          await navigate(page, 'customizer');
          await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
          const tabs = await tabGeometry(page);
          assert.deepEqual(tabs.map(tab => tab.name), destinations);
          for (const tab of tabs) {
            assert.ok(tab.visible, `${tab.name} remains visibly named at 200% text`);
            assert.ok(tab.text.length > 0, `${tab.name} has rendered label text`);
            for (const line of tab.text) {
              assert.ok(line.left >= tab.target.left - 1 && line.right <= tab.target.right + 1, `${tab.name} ${theme} ${width}px: text extends into a neighbouring target`);
              assert.ok(line.top >= tab.target.top - 1 && line.bottom <= tab.target.bottom + 1, `${tab.name}: text extends outside its target vertically`);
            }
          }
        } finally {
          await context.close();
        }
      }
    }
  });

  it('keeps short-phone content above the tabs when the whole page scrolls', async () => {
    for (const [width, height] of [[390, 320], [844, 390], [667, 375], [640, 400]]) {
      const { context, page } = await openPage({ width, height });
      try {
        await navigate(page, 'customizer');
        const bounds = await page.evaluate(() => ({
          contentBottom: document.querySelector('#main-content > div').getBoundingClientRect().bottom,
          navTop: document.querySelector('.admin-bottom-nav').getBoundingClientRect().top,
          documentWidth: document.documentElement.scrollWidth,
        }));
        assert.ok(bounds.navTop >= bounds.contentBottom - 1, `${width}×${height}: content runs under the bottom tabs`);
        assert.ok(bounds.documentWidth <= width + 1, `${width}×${height}: page overflows horizontally`);
      } finally {
        await context.close();
      }
    }
  });

  it('keeps navigation labels visible in narrow rows and preserves page-change focus', async () => {
    for (const width of [320, 390, 480, 768]) {
      const { context, page } = await openPage({ width, height: 900 });
      try {
        await navigate(page, 'customizer');
        const tabs = await tabGeometry(page);
        assert.deepEqual(tabs.map(tab => tab.name), destinations);
        assert.deepEqual(tabs.map(tab => tab.visible), Array(destinations.length).fill(true));
        assert.equal(new Set(tabs.map(tab => Math.round(tab.target.top))).size, width < 480 ? 2 : 1,
          `${width}px: names determine whether tabs use one or two rows`);
        const users = page.locator('.admin-bottom-nav').getByRole('link', { name: 'Users', exact: true });
        await users.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement?.id === 'main-content' && document.title === 'Users — plato');
        await page.getByRole('button', { name: 'Invite Users', exact: true }).waitFor({ state: 'visible' });
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), width < 768 ? 'Manage' : 'Invite Users');
      } finally {
        await context.close();
      }
    }
  });

  it('keeps model identifiers optional while preserving unsaved choices and testing', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    try {
      const { requests } = await controlAiSettings(context);
      await navigate(page, 'ai');
      const modelId = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
      const details = page.locator('summary').filter({ hasText: 'Model ID' });
      assert.equal(await details.count(), 1, 'troubleshooting identifiers have a named disclosure');
      assert.equal(await page.getByText(modelId, { exact: true }).isVisible(), false);
      await details.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.getByText(modelId, { exact: true }).isVisible(), true);

      await page.getByLabel('Cloudflare-hosted model', { exact: true }).selectOption('@cf/mistralai/mistral-small-3.1-24b-instruct');
      const active = page.getByRole('region', { name: 'Active configuration', exact: true });
      assert.match(await active.innerText(), /DeepSeek/);
      assert.match(await page.getByRole('region', { name: 'Pending changes', exact: true }).innerText(), /DeepSeek.*Mistral/s);
      assert.equal(await page.getByRole('button', { name: 'Save AI settings', exact: true }).isEnabled(), true);
      assert.match(await page.locator('form').innerText(), /may incur usage charges/);

      await page.getByRole('button', { name: 'Test connection', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Connection successful' }).waitFor();
      assert.deepEqual(requests.map(request => request.action), ['test'], 'testing never applies the draft');
      assert.match(await active.innerText(), /DeepSeek/);
      assert.equal(await page.getByRole('button', { name: 'Test connection', exact: true }).evaluate(button => button === document.activeElement), true);

      await page.getByRole('button', { name: 'Save AI settings', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'AI settings saved' }).waitFor();
      assert.deepEqual(requests.map(request => request.action), ['test', 'save']);
      assert.match(await active.innerText(), /Mistral/);
      assert.equal(await page.getByRole('region', { name: 'Pending changes', exact: true }).count(), 0);
    } finally {
      await context.close();
    }
  });

  it('restores unsaved AI choices after navigation and reload, then explicitly discards them', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    try {
      const { requests } = await controlAiSettings(context);
      await navigate(page, 'ai');
      const model = '@cf/mistralai/mistral-small-3.1-24b-instruct';
      await page.getByLabel('Cloudflare-hosted model', { exact: true }).selectOption(model);
      await page.locator('.admin-bottom-nav').getByRole('link', { name: 'Users', exact: true }).click();
      await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
      await page.locator('.admin-bottom-nav').getByRole('link', { name: 'AI Settings', exact: true }).click();
      await page.getByLabel('Cloudflare-hosted model', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Cloudflare-hosted model', { exact: true }).inputValue(), model);
      assert.match(await page.getByRole('region', { name: 'Active configuration', exact: true }).innerText(), /DeepSeek/);
      page.on('dialog', dialog => dialog.accept());
      await page.reload();
      await page.getByLabel('Cloudflare-hosted model', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Cloudflare-hosted model', { exact: true }).inputValue(), model);
      await page.getByRole('button', { name: 'Discard changes and reload', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Unsaved changes were discarded' }).waitFor();
      assert.match(await page.getByLabel('Cloudflare-hosted model', { exact: true }).inputValue(), /deepseek/);
      assert.deepEqual(requests, [], 'draft recovery and discard never save or test a provider');
    } finally { await context.close(); }
  });

  it('keeps focus on a pending Cloudflare retry and reveals its failure', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      await controlAiSettings(context, { workersAiOAuth: { available: true, connected: true, version: 1, revocationPending: true, account: { name: 'Learning Studio' } } });
      await context.route('**/v1/admin/ai-settings/cloudflare/revoke', async route => {
        await gate;
        await route.fulfill({ status: 503, json: { error: 'Access could not be revoked. Try again.' } });
      });
      await navigate(page, 'ai');
      const retry = page.getByRole('button', { name: 'Retry revoking access', exact: true });
      await retry.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Retry revoking access' && button.getAttribute('aria-disabled') === 'true'));
      assert.equal(await retry.evaluate(button => button === document.activeElement), true, 'busy buttons keep keyboard focus');
      release();
      await page.getByRole('alert').filter({ hasText: 'Access could not be revoked' }).waitFor();
      assert.equal(await retry.evaluate(button => button === document.activeElement), true);
      const feedback = await page.locator('#ai-feedback').boundingBox();
      assert.ok(feedback.y >= 0 && feedback.y + feedback.height <= 844, 'the error is visible beside the focused retry');
    } finally { release(); await context.close(); }
  });

  it('ignores a late Cloudflare connection response after leaving AI Settings', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let began;
    const started = new Promise(resolve => { began = resolve; });
    let authorizations = 0;
    try {
      await controlAiSettings(context);
      await context.route('**/v1/admin/ai-settings/cloudflare/connect', async route => {
        began();
        await gate;
        await route.fulfill({ json: { authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth?state=fixture' } });
      });
      await context.route('https://dash.cloudflare.com/**', route => {
        authorizations++;
        return route.fulfill({ contentType: 'text/html', body: '<p>Controlled authorization destination</p>' });
      });
      await navigate(page, 'ai');
      await page.getByRole('button', { name: 'Reconnect Cloudflare', exact: true }).click();
      await started;
      await page.locator('.admin-bottom-nav').getByRole('link', { name: 'Users', exact: true }).click();
      await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
      const completed = page.waitForResponse(response => response.url().endsWith('/cloudflare/connect'));
      release();
      const response = await completed;
      await response.finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))).catch(() => {});
      assert.equal(authorizations, 0, 'departed pages cannot start authorization');
      assert.equal(new URL(page.url()).pathname, '/plato/users');
    } finally { release(); await context.close(); }
  });

  it('keeps incomplete AI settings responses in a recoverable page state', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    try {
      await controlAiSettings(context);
      let incomplete = true;
      await context.route('**/v1/admin/ai-settings', route => incomplete
        ? route.fulfill({ json: {} }) : route.fallback());
      await page.goto(`${base}/plato/ai`);
      await page.waitForLoadState('networkidle');
      assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 1);
      assert.equal(await page.locator('.admin-bottom-nav').getByRole('link', { name: 'Users', exact: true }).isVisible(), true);
      incomplete = false;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.getByLabel('Cloudflare-hosted model', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'AI Settings', exact: true }).evaluate(heading => heading === document.activeElement), true);
    } finally { await context.close(); }
  });

  it('returns focus to connection context when successful actions remove their controls', async () => {
    for (const action of ['account', 'revoke', 'disconnect']) {
      const { context, page } = await openPage({ width: 390, height: 844 });
      try {
        const oauth = { available: true, connected: action !== 'account', version: 1, revocationPending: action === 'revoke',
          account: action === 'account' ? null : { name: 'Learning Studio' },
          ...(action === 'account' ? { pendingFlowId: 'fixture-flow', pendingAccounts: [{ id: 'fixture-account', name: 'Learning Studio' }] } : {}) };
        const fixture = await controlAiSettings(context, { workersAiOAuth: oauth });
        await context.route(`**/v1/admin/ai-settings/cloudflare${action === 'disconnect' ? '' : '/' + action}`, async route => {
          fixture.update({
            workersAiCredentials: { configured: action !== 'disconnect', source: 'oauth', accountId: action !== 'disconnect', apiToken: action !== 'disconnect' },
            workersAiOAuth: { available: true, connected: action !== 'disconnect', version: 2, account: { name: 'Learning Studio' }, revocationPending: false },
          });
          await route.fulfill({ json: { revocationPending: false } });
        });
        await navigate(page, 'ai');
        if (action === 'account') {
          await page.getByLabel('Account for this classroom', { exact: true }).selectOption('fixture-account');
          await page.getByRole('button', { name: 'Use this account', exact: true }).click();
        } else if (action === 'revoke') {
          await page.getByRole('button', { name: 'Retry revoking access', exact: true }).click();
        } else {
          await page.getByRole('button', { name: 'Disconnect Cloudflare', exact: true }).click();
          await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect Cloudflare', exact: true }).click();
        }
        await page.getByRole('status').filter({ hasText: /Cloudflare connected|access was revoked|Cloudflare was disconnected/ }).waitFor();
        assert.equal(await page.getByRole('heading', { name: 'Cloudflare connection', exact: true }).evaluate(heading => heading === document.activeElement), true, `${action}: focus has a stable destination`);
      } finally { await context.close(); }
    }
  });

  it('keeps incomplete saves and connection refreshes honest without losing choices', async () => {
    for (const action of ['save', 'save-status', 'connection', 'connection-status']) {
      const { context, page } = await openPage({ width: 390, height: 844 });
      try {
        const fixture = await controlAiSettings(context, { workersAiOAuth: { available: true, connected: true, version: 1, revocationPending: true, account: { name: 'Learning Studio' } } });
        const saving = action.startsWith('save');
        let broken = false;
        await context.route('**/v1/admin/ai-settings', route => {
          if ((saving && route.request().method() === 'PUT') || broken) {
            const data = action.endsWith('-status') ? fixture.snapshot() : {};
            delete data.workersAiOAuth;
            return route.fulfill({ json: data });
          }
          return route.fallback();
        });
        await context.route('**/v1/admin/ai-settings/cloudflare/revoke', async route => {
          broken = true;
          await route.fulfill({ json: { revocationPending: false } });
        });
        await navigate(page, 'ai');
        const model = page.getByLabel('Cloudflare-hosted model', { exact: true });
        await model.selectOption('@cf/mistralai/mistral-small-3.1-24b-instruct');
        await page.getByRole('button', { name: saving ? 'Save AI settings' : 'Retry revoking access', exact: true }).click();
        await page.waitForFunction(() => {
          const feedback = document.querySelector('#ai-feedback');
          return Boolean(feedback?.querySelector('[role="alert"]')?.textContent)
            || /^Previous Cloudflare access/.test(feedback?.querySelector('[role="status"]')?.textContent || '');
        });
        assert.match(await page.getByRole('alert').innerText(), saving ? /save could not be confirmed/ : /status could not be loaded/);
        assert.match(await model.inputValue(), /mistral/);
        assert.match(await page.getByRole('region', { name: 'Active configuration', exact: true }).innerText(), /DeepSeek/);
        assert.equal(await page.getByRole('region', { name: 'Pending changes', exact: true }).count(), 1);
      } finally { await context.close(); }
    }
  });

  it('does not resurrect discarded choices from an older OAuth handoff', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    try {
      await controlAiSettings(context);
      await navigate(page, 'ai');
      await page.getByLabel('Cloudflare-hosted model', { exact: true }).selectOption('@cf/mistralai/mistral-small-3.1-24b-instruct');
      await page.evaluate(() => {
        const prefix = 'plato:ai-settings-draft:';
        const key = Object.keys(sessionStorage).find(value => value.startsWith(prefix));
        const userId = decodeURIComponent(key.slice(prefix.length));
        sessionStorage.setItem(`plato:cloudflare-draft:${userId}`, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)), createdAt: Date.now() }));
      });
      await page.getByRole('button', { name: 'Discard changes and reload', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Unsaved changes were discarded' }).waitFor();
      await page.goto(`${base}/plato/ai?cloudflare=denied`);
      await page.getByLabel('Cloudflare-hosted model', { exact: true }).waitFor();
      assert.match(await page.getByLabel('Cloudflare-hosted model', { exact: true }).inputValue(), /deepseek/);
      assert.equal(await page.getByRole('region', { name: 'Pending changes', exact: true }).count(), 0);
    } finally { await context.close(); }
  });

  it('keeps a discarded provider switch discarded when an OAuth callback arrives later', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    try {
      await controlAiSettings(context, { provider: 'bedrock' });
      await navigate(page, 'ai');
      await page.getByRole('radio', { name: /Cloudflare Workers AI/ }).check();
      await page.getByRole('button', { name: 'Discard changes and reload', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Unsaved changes were discarded' }).waitFor();
      await page.goto(`${base}/plato/ai?cloudflare=denied`);
      await page.getByRole('radio', { name: /Amazon Bedrock/ }).waitFor();
      assert.equal(await page.getByRole('radio', { name: /Amazon Bedrock/ }).isChecked(), true);
      assert.equal(await page.getByRole('region', { name: 'Pending changes', exact: true }).count(), 0);
    } finally { await context.close(); }
  });

  it('does not announce completed revocation while refreshed access remains pending', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    try {
      await controlAiSettings(context, { workersAiOAuth: { available: true, connected: true, version: 1, revocationPending: true, account: { name: 'Learning Studio' } } });
      await context.route('**/v1/admin/ai-settings/cloudflare/revoke', route => route.fulfill({ json: {} }));
      await navigate(page, 'ai');
      await page.getByRole('button', { name: 'Retry revoking access', exact: true }).click();
      const result = page.getByRole('status').filter({ hasText: /^Previous Cloudflare access/ });
      await result.waitFor();
      assert.match(await result.innerText(), /still needs to be revoked/);
      assert.equal(await page.getByRole('button', { name: 'Retry revoking access', exact: true }).count(), 1);
    } finally { await context.close(); }
  });

  it('keeps navigation drafts when session storage is unavailable', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    try {
      await controlAiSettings(context);
      await navigate(page, 'ai');
      await page.evaluate(() => Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('Blocked', 'SecurityError'); } }));
      await page.getByLabel('Cloudflare-hosted model', { exact: true }).selectOption('@cf/mistralai/mistral-small-3.1-24b-instruct');
      await page.getByText('This browser cannot keep your choices through a reload.', { exact: false }).waitFor();
      await page.locator('.admin-bottom-nav').getByRole('link', { name: 'Users', exact: true }).click();
      await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
      await page.locator('.admin-bottom-nav').getByRole('link', { name: 'AI Settings', exact: true }).click();
      await page.getByLabel('Cloudflare-hosted model', { exact: true }).waitFor();
      assert.match(await page.getByLabel('Cloudflare-hosted model', { exact: true }).inputValue(), /mistral/);
    } finally { await context.close(); }
  });
});
