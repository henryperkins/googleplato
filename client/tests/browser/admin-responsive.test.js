import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const destinations = ['Home', 'Lessons', 'Users', 'Customizer', 'AI Settings', 'Plugins'];
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

describe('Rendered admin responsive regressions', { timeout: 90000 }, () => {
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
    browser = await chromium.launch();
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

  it('keeps all six enlarged-text labels visible and inside their own targets', async () => {
    for (const theme of ['light', 'dark']) {
      for (const width of [480, 768]) {
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

  it('preserves narrow-phone names, normal single-row labels, and page-change focus', async () => {
    for (const width of [320, 390, 480, 768]) {
      const { context, page } = await openPage({ width, height: 900 });
      try {
        await navigate(page, 'customizer');
        const tabs = await tabGeometry(page);
        assert.deepEqual(tabs.map(tab => tab.name), destinations);
        assert.deepEqual(tabs.map(tab => tab.visible), Array(6).fill(width >= 480));
        assert.equal(new Set(tabs.map(tab => Math.round(tab.target.top))).size, 1, `${width}px: normal tabs stay in one row`);
        const users = page.locator('.admin-bottom-nav').getByRole('link', { name: 'Users', exact: true });
        await users.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement?.id === 'main-content' && document.title === 'Users — plato');
        await page.getByRole('button', { name: 'Invite Users', exact: true }).waitFor({ state: 'visible' });
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'Invite Users');
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
