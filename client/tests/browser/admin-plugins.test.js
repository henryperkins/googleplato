import { browserEvidence } from './evidence.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const evidence = browserEvidence('admin-plugins');
const manifests = Object.fromEntries(await Promise.all(['google-auth', 'slack', 'teacher-comments'].map(async (id) => [
  id,
  JSON.parse(await readFile(join(root, 'plugins', id, 'plugin.json'), 'utf8')),
])));

function pluginView(id, overrides = {}) {
  const manifest = manifests[id];
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    capabilities: manifest.capabilities,
    slots: Object.keys(manifest.extensionPoints?.slots || {}),
    hasSettingsSchema: !!manifest.settingsSchema,
    settingsSchema: manifest.settingsSchema || null,
    hasStoredState: false,
    enabled: true,
    loadError: null,
    settings: {},
    ...overrides,
  };
}

function effectiveGoogleSettings(overrides = {}) {
  return {
    ...Object.fromEntries(Object.entries(manifests['google-auth'].settingsSchema.properties).map(([key, schema]) => [key, schema.default])),
    ...overrides,
  };
}

async function controlPluginReads(context, getPlugins) {
  let listReads = 0;
  await context.route('**/v1/admin/plugins', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    listReads++;
    return route.fulfill({ json: getPlugins() });
  });
  await context.route('**/v1/plugins', route => route.fulfill({
    json: getPlugins().filter(plugin => plugin.enabled && !plugin.loadError),
  }));
  return () => listReads;
}

describe('Rendered plugin administration regressions', { timeout: 180000 }, () => {
  let browser;
  let server;
  let directory;
  let base;
  let storageState;
  let firebaseAssets;

  before(async () => {
    assert.ok(existsSync(join(root, 'client/dist/index.html')), 'Run npm run build:client before browser tests');
    const assets = await readdir(join(root, 'client/dist/assets'));
    firebaseAssets = new Set(await Promise.all(assets.filter(name => name.endsWith('.js')).map(async name => {
      const source = await readFile(join(root, 'client/dist/assets', name), 'utf8');
      return /identitytoolkit|initializeApp|FirebaseError/.test(source) ? name : null;
    })).then(names => names.filter(Boolean)));
    assert.ok(firebaseAssets.size > 0, 'The build still contains the Google provider Firebase bundle');

    directory = await mkdtemp(join(tmpdir(), 'plato-admin-plugins-'));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    base = `http://127.0.0.1:${port}`;
    const email = 'plugins@plato.test';
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

    browser = await chromium.launch({ executablePath: process.env.PLATO_TEST_BROWSER_EXECUTABLE || undefined });
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

  async function openPage(viewport = { width: 1280, height: 900 }, options = {}) {
    const context = await browser.newContext({ viewport, storageState, ...options });
    const page = await context.newPage();
    return { context, page };
  }

  async function navigate(page) {
    await page.goto(`${base}/plato/plugins`);
    await page.locator('#main-content h1').waitFor();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
  }

  it('shows effective Google settings and restores a default when its override is cleared', async () => {
    const { context, page } = await openPage();
    const writes = [];
    try {
      await context.route('**/v1/admin/plugins/google-auth/settings', async route => {
        writes.push(route.request().postDataJSON());
        await route.continue();
      });
      await navigate(page);
      const apiKey = page.getByLabel('API key (required)', { exact: true });
      await apiKey.waitFor();
      assert.equal(await apiKey.inputValue(), manifests['google-auth'].settingsSchema.properties.apiKey.default);
      assert.match(await apiKey.getAttribute('aria-describedby'), /plugin-google-auth-apiKey-description/);
      await page.screenshot({ path: join(evidence, 'google-default-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => localStorage.setItem('plato_theme', 'dark'));
      await page.reload();
      await page.getByLabel('API key (required)', { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(evidence, 'google-default-mobile-dark.png'), fullPage: true });
      await apiKey.fill('   ');
      // Before saving, the cleared field says what saving will do with it.
      await page.getByText('Saving restores the default.', { exact: true }).waitFor();
      assert.match(await apiKey.getAttribute('aria-describedby'), /plugin-google-auth-apiKey-hint/);
      await page.getByRole('button', { name: 'Save Google Sign-In settings', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Settings saved. API key was reset to its default.' }).waitFor();
      assert.equal(writes.length, 1);
      assert.equal(Object.hasOwn(writes[0], 'apiKey'), false, 'a blank override is not persisted');
      assert.equal(await apiKey.inputValue(), manifests['google-auth'].settingsSchema.properties.apiKey.default);
      const providers = await page.evaluate(() => fetch('/v1/auth/providers').then(response => response.json()));
      assert.equal(providers.find(provider => provider.id === 'google-auth').config.apiKey, manifests['google-auth'].settingsSchema.properties.apiKey.default);

      // A save that changes a value updates the card's saved settings. The
      // result stays announced, and focus stays on Save once nothing is left
      // to save.
      await page.getByLabel('Auth domain (required)', { exact: true }).fill('learn.example.test');
      const save = page.getByRole('button', { name: 'Save Google Sign-In settings', exact: true });
      await save.focus();
      await page.keyboard.press('Enter');
      const saved = page.getByRole('status').filter({ hasText: 'Settings saved.' });
      await saved.waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await saved.count(), 1, 'the saved result is not cleared by the settings it saved');
      assert.equal(writes.length, 2);
      assert.equal(writes[1].authDomain, 'learn.example.test');
      assert.equal(await save.evaluate(button => button === document.activeElement), true, 'a finished save keeps focus on Save');
      assert.equal(await save.getAttribute('aria-disabled'), 'true');
      assert.equal(await page.getByText('Unsaved changes', { exact: true }).count(), 0);
    } finally {
      await context.close();
    }
  });

  it('keeps focus through Reload plugins, then moves it to the page heading', async () => {
    const { context, page } = await openPage();
    let reads = 0;
    let release;
    const reload = new Promise(resolve => { release = resolve; });
    try {
      await context.route('**/v1/admin/plugins', async route => {
        if (route.request().method() !== 'GET') return route.fallback();
        reads++;
        if (reads === 1) return route.fulfill({ status: 503, json: { error: 'Plugins are temporarily unavailable.' } });
        await reload;
        return route.fulfill({ json: [pluginView('teacher-comments', { enabled: false })] });
      });
      await context.route('**/v1/plugins', route => route.fulfill({ json: [] }));
      await navigate(page);
      const alert = page.getByRole('alert').filter({ hasText: 'Plugins are temporarily unavailable.' });
      await alert.waitFor();
      await alert.getByRole('button', { name: 'Reload plugins', exact: true }).focus();
      await page.keyboard.press('Enter');
      const pending = alert.getByRole('button', { name: 'Reloading…', exact: true });
      await pending.waitFor();
      assert.equal(await pending.evaluate(button => button === document.activeElement), true, 'a pending reload keeps focus');
      release();
      await page.getByRole('heading', { name: 'Teacher Comments', exact: true }).waitFor();
      assert.equal(await alert.count(), 0);
      assert.equal(await page.getByRole('heading', { level: 1, name: 'Plugins', exact: true }).evaluate(heading => heading === document.activeElement), true,
        'focus moves to the page heading when the reloaded list replaces the alert');
    } finally {
      release();
      await context.close();
    }
  });

  it('keeps drafts and focus through per-card activation, retry, and data deletion', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    let release;
    const firstActivation = new Promise(resolve => { release = resolve; });
    let releaseRetry;
    const retryActivation = new Promise(resolve => { releaseRetry = resolve; });
    let plugins = [
      pluginView('google-auth', { settings: effectiveGoogleSettings() }),
      pluginView('teacher-comments', { enabled: false, hasStoredState: true }),
    ];
    const listReads = await controlPluginReads(context, () => plugins);
    const activations = [];
    try {
      await context.route('**/v1/admin/plugins/teacher-comments/activation', async route => {
        const enabled = route.request().postDataJSON().enabled;
        activations.push(enabled);
        if (activations.length === 1) await firstActivation;
        if (activations.length === 2) {
          return route.fulfill({ status: 503, json: { error: 'Activation is temporarily unavailable.' } });
        }
        if (activations.length === 3) await retryActivation;
        plugins = plugins.map(plugin => plugin.id === 'teacher-comments' ? { ...plugin, enabled } : plugin);
        const updated = plugins.find(plugin => plugin.id === 'teacher-comments');
        return route.fulfill({ json: updated });
      });
      await context.route('**/v1/admin/plugins/teacher-comments/uninstall-data', async route => {
        plugins = plugins.map(plugin => plugin.id === 'teacher-comments' ? { ...plugin, hasStoredState: false, settings: {} } : plugin);
        await route.fulfill({ json: { ok: true } });
      });
      await navigate(page);
      const authDomain = page.getByLabel('Auth domain (required)', { exact: true });
      await authDomain.fill('unsaved.example');
      const teacherCard = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Teacher Comments', exact: true }) });
      const switchControl = teacherCard.getByRole('switch', { name: 'Enable Teacher Comments', exact: true });
      await switchControl.focus();
      await switchControl.press('Space');
      await teacherCard.getByText('Enabling…', { exact: true }).waitFor();
      assert.equal(await switchControl.getAttribute('aria-busy'), 'true');
      assert.equal(await switchControl.getAttribute('aria-disabled'), 'true');
      assert.equal(await switchControl.evaluate(control => control === document.activeElement), true);
      await switchControl.press('Space');
      assert.deepEqual(activations, [true], 'a pending switch rejects repeat activation');
      release();
      await page.waitForFunction(() => document.querySelector('[aria-label="Enable Teacher Comments"]')?.getAttribute('aria-checked') === 'true');
      assert.equal(await authDomain.inputValue(), 'unsaved.example', 'an unrelated activation preserves the settings draft');

      await switchControl.click();
      const failure = teacherCard.getByRole('alert').filter({ hasText: 'Activation is temporarily unavailable.' });
      await failure.waitFor();
      assert.deepEqual(activations, [true, false]);
      const failureBox = await failure.boundingBox();
      assert.ok(failureBox.y >= 0 && failureBox.y + failureBox.height <= 844, 'the activation error stays beside the card being changed');
      assert.equal(listReads(), 1, 'a failed activation does not reload the list');
      await teacherCard.getByRole('button', { name: 'Try again', exact: true }).focus();
      await page.keyboard.press('Enter');
      const retrying = teacherCard.getByRole('button', { name: 'Trying again…', exact: true });
      await retrying.waitFor();
      assert.equal(await retrying.evaluate(button => button === document.activeElement), true, 'a pending retry keeps its alert and focus');
      assert.equal(await retrying.getAttribute('aria-disabled'), 'true');
      releaseRetry();
      await page.waitForFunction(() => document.querySelector('[aria-label="Enable Teacher Comments"]')?.getAttribute('aria-checked') === 'false');
      assert.deepEqual(activations, [true, false, false], 'Try again repeats the failed activation');
      assert.equal(await teacherCard.getByRole('alert').count(), 0);
      assert.equal(await switchControl.evaluate(control => control === document.activeElement), true, 'a successful retry returns focus to the switch');

      await teacherCard.getByRole('button', { name: 'Delete plugin data', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete Teacher Comments data?', exact: true });
      await dialog.locator('#confirm-teacher-comments').fill('teacher-comments');
      await dialog.locator('#confirm-teacher-comments').press('Enter');
      await teacherCard.locator('p').getByText('Teacher Comments data deleted.', { exact: true }).waitFor();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await teacherCard.getByRole('heading', { name: 'Teacher Comments', exact: true }).evaluate(heading => heading === document.activeElement), true);
      assert.equal(listReads(), 1, 'deletion updates only the affected card');
    } finally {
      release();
      releaseRetry();
      await context.close();
    }
  });

  it('keeps connected Slack settings readable on phones and preserves auto-invite configuration on disconnect', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
    let plugins = [pluginView('slack', {
      settings: {
        workspaceName: 'Northwind Learning', connected: true,
        autoInviteEnabled: true, autoInviteChannelId: 'C-learning', autoInviteChannelName: 'learning',
      },
    })];
    await controlPluginReads(context, () => plugins);
    await context.route('**/v1/plugins/slack/admin/channels', route => route.fulfill({ json: [{ id: 'C-learning', name: 'learning' }] }));
    await context.route('**/v1/plugins/slack/admin/auto-invite', route => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ json: { results: [
        { userId: 'long', name: 'Blair West', email: 'blair.west.long.address@learning-cohort.example', status: 'failed', channelId: 'C-learning' },
        { userId: 'running', name: 'Avery North', email: 'avery@example.test', status: 'pending', channelId: 'C-learning', inProgress: true },
        { userId: 'added', name: 'Casey East', email: 'casey@example.test', status: 'invited', channelId: 'C-learning' },
      ] } });
    });
    let disconnectBody;
    try {
      await navigate(page);
      await page.getByRole('button', { name: 'Retry everyone not added (1)', exact: true }).waitFor();
      const trailing = await page.locator('fieldset').evaluate(fieldset => fieldset.getBoundingClientRect().bottom
        - fieldset.querySelector('ul[aria-label="Auto-invite results"]').getBoundingClientRect().bottom);
      assert.ok(trailing <= 1, `empty status regions add no space below the results (${trailing}px)`);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1, `${width}px: the document stays within the viewport`);
        const geometry = await page.locator('fieldset').evaluate(fieldset => {
          const card = fieldset.closest('[data-slot="card"]');
          const email = [...fieldset.querySelectorAll('span')].find(span => span.textContent.startsWith('blair.west.long.address@'));
          return { fieldset: fieldset.getBoundingClientRect().toJSON(), card: card.getBoundingClientRect().toJSON(), email: email.getBoundingClientRect().toJSON() };
        });
        assert.ok(geometry.fieldset.width <= geometry.card.width, `${width}px: the fieldset shrinks inside its card`);
        assert.ok(geometry.email.right <= geometry.card.right + 1, `${width}px: the long email is not clipped`);
        const checkboxLabel = await page.getByText('Add new accounts to a channel', { exact: true }).last().boundingBox();
        assert.ok(checkboxLabel.height >= 44, 'the auto-invite checkbox has a touch-sized label');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 391, 'connected Slack settings reflow at 200% text size');
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      await page.getByRole('heading', { name: 'Recent results', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, 'slack-results-390.png'), fullPage: true });
      await page.emulateMedia({ forcedColors: 'active' });
      const forcedColors = await page.locator('[data-slot="card"]').evaluate(card => ({
        cardOutline: getComputedStyle(card).outlineWidth,
        switchOutline: getComputedStyle(card.querySelector('[role="switch"] > span')).outlineWidth,
        // Forced colors repaint author fills as Canvas; the rule keeps a system color.
        separatorShows: getComputedStyle(card.querySelector('[data-slot="separator"]')).backgroundColor
          !== getComputedStyle(card).backgroundColor,
      }));
      assert.deepEqual(forcedColors, { cardOutline: '1px', switchOutline: '1px', separatorShows: true });
      await page.screenshot({ path: join(evidence, 'plugins-forced-colors.png'), fullPage: true });
      await page.emulateMedia({ forcedColors: 'none' });

      await context.route('**/v1/admin/plugins/slack/settings', async route => {
        disconnectBody = route.request().postDataJSON();
        const settings = { ...disconnectBody };
        delete settings.botToken;
        plugins = [{ ...plugins[0], settings }];
        await route.fulfill({ json: plugins[0] });
      });
      await page.getByRole('button', { name: 'Disconnect Slack', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Disconnect Slack?', exact: true });
      await dialog.getByText(/auto-invite settings will be kept/i).waitFor();
      await page.screenshot({ path: join(evidence, 'slack-disconnect-dialog-390.png'), fullPage: true });
      await dialog.getByRole('button', { name: 'Disconnect Slack', exact: true }).click();
      await page.getByLabel('Bot User OAuth Token', { exact: true }).waitFor();
      assert.equal(disconnectBody.botToken, null);
      assert.equal(disconnectBody.autoInviteEnabled, true);
      assert.equal(disconnectBody.autoInviteChannelId, 'C-learning');
      assert.equal(disconnectBody.autoInviteChannelName, 'learning');
      assert.equal(await page.getByLabel('Bot User OAuth Token', { exact: true }).evaluate(input => input === document.activeElement), true);
      await page.getByRole('status').filter({ hasText: 'Slack disconnected. Auto-invite settings were kept.' }).waitFor();
    } finally {
      await context.close();
    }
  });

  it('moves focus to the connection status after connecting Slack', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 });
    let plugins = [pluginView('slack', { settings: { connected: false, autoInviteEnabled: false } })];
    let saved;
    try {
      await controlPluginReads(context, () => plugins);
      await context.route('**/v1/plugins/slack/admin/test', route => route.fulfill({ json: { ok: true, team: 'Northwind Learning' } }));
      await context.route('**/v1/plugins/slack/admin/channels', route => route.fulfill({ json: [] }));
      await context.route('**/v1/plugins/slack/admin/auto-invite', route => route.fulfill({ json: { results: [] } }));
      await context.route('**/v1/admin/plugins/slack/settings', async route => {
        saved = route.request().postDataJSON();
        const settings = { ...saved };
        delete settings.botToken;
        plugins = [{ ...plugins[0], settings }];
        await route.fulfill({ json: plugins[0] });
      });
      await navigate(page);
      await page.getByLabel('Bot User OAuth Token', { exact: true }).fill('xoxb-test-token');
      await page.getByRole('button', { name: 'Test Connection', exact: true }).click();
      const connect = page.getByRole('button', { name: 'Connect to Northwind Learning', exact: true });
      await connect.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('status').filter({ hasText: 'Slack integration saved.' }).waitFor();
      assert.deepEqual([saved.botToken, saved.workspaceName, saved.connected], ['xoxb-test-token', 'Northwind Learning', true]);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'Connected to Northwind Learning',
        'connecting replaces the focused button, so focus moves to the connection status');
    } finally {
      await context.close();
    }
  });

  it('keeps a stored required secret through other saves and says what saving does with it', async () => {
    const { context, page } = await openPage();
    const schema = {
      type: 'object',
      required: ['apiSecret'],
      properties: {
        apiSecret: { type: 'string', title: 'API secret', description: 'From the service dashboard.', writeOnly: true },
        region: { type: 'string', title: 'Region', default: 'us' },
      },
    };
    const synthetic = (id, name, storedWriteOnly) => ({
      id, name, version: '1.0.0', description: 'Synthetic plugin with a required secret.', capabilities: [], slots: [],
      hasSettingsSchema: true, settingsSchema: schema, hasStoredState: true, enabled: true, loadError: null,
      settings: { region: 'us' }, storedWriteOnly,
    });
    let plugins = [synthetic('stored-secret', 'Stored Secret', ['apiSecret']), synthetic('missing-secret', 'Missing Secret', [])];
    const writes = [];
    try {
      await controlPluginReads(context, () => plugins);
      await context.route('**/v1/admin/plugins/*/settings', async route => {
        const id = new URL(route.request().url()).pathname.split('/').at(-2);
        const body = route.request().postDataJSON();
        writes.push({ id, body });
        const { apiSecret, ...settings } = body;
        plugins = plugins.map(plugin => plugin.id !== id ? plugin : {
          ...plugin,
          settings: { region: 'us', ...settings },
          storedWriteOnly: apiSecret || plugin.storedWriteOnly.includes('apiSecret') ? ['apiSecret'] : [],
        });
        await route.fulfill({ json: plugins.find(plugin => plugin.id === id) });
      });
      await navigate(page);
      const card = name => page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name, exact: true }) });
      const stored = card('Stored Secret');
      const secret = stored.getByLabel('API secret (required)', { exact: true });
      const savedHint = stored.getByText('A value is saved. Leave this blank to keep it.', { exact: true });
      await savedHint.waitFor();
      assert.equal(await secret.inputValue(), '');
      assert.equal(await secret.getAttribute('autocomplete'), 'off', 'the browser never fills a sign-in password into a plugin secret');
      assert.equal(await secret.getAttribute('aria-describedby'), 'plugin-stored-secret-apiSecret-description plugin-stored-secret-apiSecret-hint');

      await stored.getByLabel('Region', { exact: true }).fill('eu');
      await stored.getByRole('button', { name: 'Save Stored Secret settings', exact: true }).click();
      await stored.getByRole('status').filter({ hasText: 'Settings saved.' }).waitFor();
      assert.deepEqual(writes, [{ id: 'stored-secret', body: { region: 'eu' } }], 'a blank stored secret is left out, so the server keeps it');

      await secret.fill('replacement-secret');
      await stored.getByText('Saving replaces the saved value.', { exact: true }).waitFor();
      const save = stored.getByRole('button', { name: 'Save Stored Secret settings', exact: true });
      await save.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#plugin-stored-secret-apiSecret')?.value === '');
      assert.deepEqual(writes[1], { id: 'stored-secret', body: { region: 'eu', apiSecret: 'replacement-secret' } });
      await savedHint.waitFor();
      assert.equal(await stored.getByText('Unsaved changes', { exact: true }).count(), 0, 'a saved secret leaves the form without marking it unsaved');
      assert.equal(await save.evaluate(button => button === document.activeElement), true);
      await secret.fill('typed then erased');
      await secret.fill('');
      assert.equal(await stored.getByText('Unsaved changes', { exact: true }).count(), 0, 'an erased secret, which saving leaves out, is not a change');
      await page.screenshot({ path: join(evidence, 'stored-secret-desktop.png'), fullPage: true });

      const missing = card('Missing Secret');
      await missing.getByLabel('Region', { exact: true }).fill('eu');
      await missing.getByRole('button', { name: 'Save Missing Secret settings', exact: true }).click();
      const missingSecret = missing.getByLabel('API secret (required)', { exact: true });
      await missing.getByText('API secret is required.', { exact: true }).waitFor();
      assert.equal(await missingSecret.evaluate(input => input === document.activeElement), true);
      assert.equal(await missingSecret.getAttribute('aria-invalid'), 'true');
      assert.equal(await missing.getByText(/A value is saved/).count(), 0);
      assert.equal(writes.length, 2, 'a secret that was never saved is still required');
    } finally {
      await context.close();
    }
  });

  it('withdraws Connect when the Slack token changes after its test', async () => {
    const { context, page } = await openPage();
    let plugins = [pluginView('slack', { settings: { connected: false, autoInviteEnabled: false } })];
    const tested = [];
    let holdTest = null;
    let saved;
    try {
      await controlPluginReads(context, () => plugins);
      await context.route('**/v1/plugins/slack/admin/test', async route => {
        const { botToken } = route.request().postDataJSON();
        tested.push(botToken);
        if (holdTest) await holdTest;
        if (botToken === 'xoxb-revoked') {
          return route.fulfill({ status: 400, json: { error: 'Invalid token or Slack API error', code: 'invalid_auth' } });
        }
        return route.fulfill({ json: { ok: true, team: 'Northwind Learning' } });
      });
      await context.route('**/v1/plugins/slack/admin/channels', route => route.fulfill({ json: [] }));
      await context.route('**/v1/plugins/slack/admin/auto-invite', route => route.fulfill({ json: { results: [] } }));
      await context.route('**/v1/admin/plugins/slack/settings', async route => {
        saved = route.request().postDataJSON();
        const settings = { ...saved };
        delete settings.botToken;
        plugins = [{ ...plugins[0], settings }];
        await route.fulfill({ json: plugins[0] });
      });
      await navigate(page);
      const token = page.getByLabel('Bot User OAuth Token', { exact: true });
      const testButton = page.getByRole('button', { name: 'Test Connection', exact: true });
      const connect = page.getByRole('button', { name: 'Connect to Northwind Learning', exact: true });
      const passed = page.getByRole('status').filter({ hasText: 'Connection test passed' });
      assert.equal(await token.getAttribute('autocomplete'), 'off');

      await token.fill('xoxb-tested');
      await testButton.click();
      await connect.waitFor();
      await token.fill('xoxb-edited');
      await connect.waitFor({ state: 'detached' });
      assert.equal(await passed.count(), 0, 'the passed test is withdrawn with Connect');

      // A test that finishes after the token changed doesn't offer Connect.
      let release;
      holdTest = new Promise(resolve => { release = resolve; });
      await testButton.click();
      await page.getByRole('button', { name: 'Testing…', exact: true }).waitFor();
      await token.fill('xoxb-changed-while-testing');
      release();
      holdTest = null;
      await testButton.waitFor();
      assert.equal(await connect.count(), 0);
      assert.equal(await passed.count(), 0);

      await token.fill('xoxb-revoked');
      await testButton.click();
      await page.getByRole('status').filter({ hasText: 'Slack didn’t accept this token.' }).waitFor();
      assert.equal(await connect.count(), 0);

      await token.fill('xoxb-final');
      await testButton.click();
      await connect.click();
      await page.getByRole('status').filter({ hasText: 'Slack integration saved.' }).waitFor();
      assert.deepEqual([saved.botToken, saved.workspaceName, saved.connected], ['xoxb-final', 'Northwind Learning', true]);
      assert.deepEqual(tested, ['xoxb-tested', 'xoxb-edited', 'xoxb-revoked', 'xoxb-final']);
    } finally {
      await context.close();
    }
  });

  it('explains a failed Slack channel load, keeps the saved channel, and marks unsaved auto-invite edits', async () => {
    const { context, page } = await openPage();
    let plugins = [pluginView('slack', {
      settings: {
        workspaceName: 'Northwind Learning', connected: true,
        autoInviteEnabled: true, autoInviteChannelId: 'C-learning', autoInviteChannelName: 'learning',
      },
    })];
    let channelLoads = 0;
    let releaseReload;
    const reload = new Promise(resolve => { releaseReload = resolve; });
    const writes = [];
    try {
      await controlPluginReads(context, () => plugins);
      await context.route('**/v1/plugins/slack/admin/channels', async route => {
        channelLoads++;
        if (channelLoads === 1) {
          return route.fulfill({ status: 500, json: { error: 'Slack API error', code: 'missing_scope', needed: 'channels:read' } });
        }
        await reload;
        return route.fulfill({ json: [{ id: 'C-general', name: 'general' }, { id: 'C-learning', name: 'learning' }] });
      });
      await context.route('**/v1/plugins/slack/admin/auto-invite', route => route.fulfill({ json: { results: [] } }));
      await context.route('**/v1/admin/plugins/slack/settings', async route => {
        const body = route.request().postDataJSON();
        writes.push(body);
        const settings = { ...body };
        delete settings.botToken;
        plugins = [{ ...plugins[0], settings }];
        await route.fulfill({ json: plugins[0] });
      });
      await navigate(page);
      const select = page.getByLabel('Channel', { exact: true });
      const failure = page.getByRole('alert').filter({ hasText: 'Channels couldn’t be loaded' });
      await failure.waitFor();
      assert.match(await failure.innerText(), /the Slack app needs the channels:read scope/);
      assert.equal(await select.inputValue(), 'C-learning', 'the saved channel stays selected when the list fails');
      assert.equal(await select.locator('option:checked').innerText(), '#learning');
      assert.equal(await select.getAttribute('aria-describedby'), 'slack-auto-channel-load-error');
      await page.screenshot({ path: join(evidence, 'slack-channels-failed.png'), fullPage: true });

      const save = page.getByRole('button', { name: 'Save auto-invite settings', exact: true });
      const enabled = page.getByRole('checkbox', { name: 'Add new accounts to a channel', exact: true });
      const unsaved = page.getByText('Unsaved changes', { exact: true });
      assert.equal(await save.getAttribute('aria-disabled'), 'true', 'nothing to save yet');
      assert.equal(await unsaved.count(), 0);
      await enabled.uncheck();
      await unsaved.waitFor();
      await enabled.check();
      assert.equal(await unsaved.count(), 0, 'restoring the saved choice leaves nothing to save');

      // Saving while the list is unavailable keeps the channel and its name.
      await enabled.uncheck();
      await save.click();
      await page.getByRole('status').filter({ hasText: 'Auto-invite is off.' }).waitFor();
      assert.deepEqual(
        [writes[0].autoInviteEnabled, writes[0].autoInviteChannelId, writes[0].autoInviteChannelName],
        [false, 'C-learning', 'learning'],
      );
      assert.equal(await save.getAttribute('aria-disabled'), 'true');
      assert.equal(await save.evaluate(button => button === document.activeElement), true, 'a finished save keeps focus on Save');

      const reloadButton = failure.getByRole('button', { name: 'Reload channels', exact: true });
      await reloadButton.focus();
      await page.keyboard.press('Enter');
      const reloading = failure.getByRole('button', { name: 'Reloading…', exact: true });
      await reloading.waitFor();
      assert.equal(await reloading.evaluate(button => button === document.activeElement), true, 'a pending reload keeps focus');
      releaseReload();
      await failure.waitFor({ state: 'detached' });
      assert.equal(await select.evaluate(field => field === document.activeElement), true, 'a successful reload moves focus to the channel field');
      assert.equal(await select.locator('option:checked').innerText(), '#learning');
      assert.equal(await select.getAttribute('aria-describedby'), null);

      await enabled.check();
      await select.selectOption('');
      await save.click();
      const required = page.getByText('Choose a channel for new accounts.', { exact: true });
      await required.waitFor();
      assert.equal(await select.evaluate(field => field === document.activeElement), true);
      assert.equal(await select.getAttribute('aria-invalid'), 'true');
      assert.equal(await select.getAttribute('aria-describedby'), 'slack-auto-channel-error');
      assert.equal(writes.length, 1, 'turning auto-invite on needs a channel');

      await select.selectOption('C-general');
      assert.equal(await required.count(), 0);
      await save.click();
      await page.getByRole('status').filter({ hasText: 'New accounts will be added to #general.' }).waitFor();
      assert.deepEqual(
        [writes[1].autoInviteEnabled, writes[1].autoInviteChannelId, writes[1].autoInviteChannelName],
        [true, 'C-general', 'general'],
      );
    } finally {
      releaseReload();
      await context.close();
    }
  });

  it('lists the newest Slack results on phones and the rest on request', async () => {
    const { context, page } = await openPage({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
    const plugins = [pluginView('slack', {
      settings: {
        workspaceName: 'Northwind Learning', connected: true,
        autoInviteEnabled: true, autoInviteChannelId: 'C-learning', autoInviteChannelName: 'learning',
      },
    })];
    const results = Array.from({ length: 14 }, (_, index) => ({
      userId: `learner-${index + 1}`, name: `Learner ${index + 1}`, email: `learner${index + 1}@example.test`,
      status: index % 3 === 0 ? 'failed' : 'invited', channelId: 'C-learning',
    }));
    try {
      await controlPluginReads(context, () => plugins);
      await context.route('**/v1/plugins/slack/admin/channels', route => route.fulfill({ json: [{ id: 'C-learning', name: 'learning' }] }));
      await context.route('**/v1/plugins/slack/admin/auto-invite', route => route.fulfill({ json: { results } }));
      await navigate(page);
      const list = page.getByRole('list', { name: 'Auto-invite results', exact: true });
      await list.waitFor();
      const visibleRows = () => list.locator('li').evaluateAll(rows => rows.filter(row => row.getBoundingClientRect().height > 0).length);
      assert.equal(await visibleRows(), 10);
      assert.equal(await list.evaluate(ul => ul.scrollHeight <= ul.clientHeight + 1), true, 'phones get no scrolling box inside the page');
      const expand = page.getByRole('button', { name: 'Show all 14 results', exact: true });
      assert.equal(await expand.getAttribute('aria-expanded'), 'false');
      assert.equal(await expand.getAttribute('aria-controls'), 'slack-auto-invite-results');
      await expand.tap();
      assert.equal(await visibleRows(), 14);
      const collapse = page.getByRole('button', { name: 'Show the 10 newest', exact: true });
      assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
      await page.screenshot({ path: join(evidence, 'slack-results-expanded-390.png'), fullPage: true });
      await collapse.tap();
      assert.equal(await visibleRows(), 10);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const collapsed = await page.getByRole('button', { name: 'Show all 14 results', exact: true }).boundingBox();
      assert.ok(collapsed && collapsed.y >= 0 && collapsed.y + collapsed.height <= 844, 'collapsing keeps its button in view');

      await page.setViewportSize({ width: 1280, height: 900 });
      assert.equal(await visibleRows(), 14, 'wider screens list every result');
      assert.equal(await list.evaluate(ul => getComputedStyle(ul).maxHeight), '240px');
      assert.equal(await page.getByRole('button', { name: 'Show all 14 results', exact: true }).isVisible(), false);
    } finally {
      await context.close();
    }
  });

  it('keeps the Firebase provider bundle off admin while retaining it on sign-in', async () => {
    const { context, page } = await openPage();
    const firebaseRequests = [];
    try {
      page.on('request', request => {
        if (firebaseAssets.has(basename(new URL(request.url()).pathname))) firebaseRequests.push(request.url());
      });
      await navigate(page);
      await page.getByLabel('API key (required)', { exact: true }).waitFor();
      assert.deepEqual(firebaseRequests, [], 'the generic admin form does not import the public provider');
    } finally {
      await context.close();
    }

    const loginContext = await browser.newContext();
    try {
      const loginPage = await loginContext.newPage();
      const providerBundle = loginPage.waitForRequest(request => firebaseAssets.has(basename(new URL(request.url()).pathname)));
      await loginPage.goto(`${base}/login`);
      await providerBundle;
    } finally {
      await loginContext.close();
    }
  });
});
