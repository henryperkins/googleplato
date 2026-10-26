import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../..', import.meta.url));
let browser;
let server;
let directory;
let base;
let storageState;
const browserName = process.env.PLATO_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';

async function openPage(viewport, theme = 'light', colorScheme = 'light') {
  const context = await browser.newContext({ viewport, storageState, colorScheme });
  await context.addInitScript(value => value ? localStorage.setItem('plato_theme', value) : localStorage.removeItem('plato_theme'), theme);
  const page = await context.newPage();
  return { context, page };
}

async function navigate(page, section) {
  await page.goto(`${base}/plato/${section}`);
  await page.locator('#main-content h1').waitFor();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}

describe('Classroom Customizer browser regressions', { timeout: 90000 }, () => {
  before(async () => {
    assert.ok(existsSync(join(root, 'client/dist/index.html')), 'Run npm run build:client before browser tests');
    directory = await mkdtemp(join(tmpdir(), 'plato-customizer-'));
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
    const initialBranding = await (await fetch(`${base}/v1/branding`)).json();
    assert.deepEqual(initialBranding.theme, { primary: '#8b1a1a' }, 'new classrooms match the primary accent');
    browser = await (browserName === 'webkit' ? webkit : chromium).launch();
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

  beforeEach(async () => {
    const auth = JSON.parse(storageState.origins[0].localStorage.find(item => item.name === 'plato_auth').value);
    const response = await fetch(`${base}/v1/admin/theme`, {
      method: 'PUT', headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: { primary: '#8b1a1a' }, classroomName: '', logoBase64: null }),
    });
    assert.equal(response.status, 200);
  });

  it('tracks saves, later edits, discard and staged defaults', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await navigate(page, 'customizer');
      const save = page.getByRole('button', { name: 'Save', exact: true });
      assert.equal(await save.isDisabled(), true);
      await page.getByLabel('Classroom Name', { exact: true }).fill('  Studio & Academy  ');
      assert.equal(await save.isEnabled(), true);
      await save.click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      assert.equal(await page.getByLabel('Classroom Name', { exact: true }).inputValue(), 'Studio & Academy');
      assert.equal(await save.isDisabled(), true);
      await page.getByLabel('Classroom Name', { exact: true }).fill('Unpublished');
      assert.equal(await page.getByText('Saved.', { exact: false }).count(), 0);
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      assert.equal(await page.getByLabel('Classroom Name', { exact: true }).inputValue(), 'Studio & Academy');
      assert.equal(await save.isDisabled(), true);
      await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click();
      assert.equal(await page.getByLabel('Classroom Name', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('Match primary', { exact: true }).isChecked(), true);
      assert.equal(await save.isEnabled(), true);
      const branding = await (await page.request.get(`${base}/v1/branding`)).json();
      assert.equal(branding.classroomName, 'Studio & Academy', 'Reset remains a draft until Save');
    } finally { await context.close(); }
  });

  it('protects sidebar links, browser Back, and reloads, then permits leaving', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await navigate(page, '');
      await page.getByRole('link', { name: 'Customizer', exact: true }).click();
      await page.getByLabel('Classroom Name', { exact: true }).fill('Keep this draft');
      await page.getByRole('link', { name: 'Users', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: 'Stay here', exact: true }).click();
      assert.match(page.url(), /\/plato\/customizer$/);
      assert.equal(await page.getByLabel('Classroom Name', { exact: true }).inputValue(), 'Keep this draft');
      await page.evaluate(() => history.back());
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: 'Stay here', exact: true }).click();
      await page.waitForURL(`${base}/plato/customizer`);
      const dialog = page.waitForEvent('dialog').then(async event => { assert.equal(event.type(), 'beforeunload'); await event.dismiss(); });
      await Promise.allSettled([page.reload({ timeout: 3000 }), dialog]);
      assert.equal(await page.getByLabel('Classroom Name', { exact: true }).inputValue(), 'Keep this draft');
      await page.evaluate(() => history.back());
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: 'Leave without saving', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/plato' || url.pathname === '/plato/');
      await page.goForward();
      await page.getByLabel('Classroom Name', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Classroom Name', { exact: true }).inputValue(), '');
    } finally { await context.close(); }
  });

  it('holds the last complete preview while typing, links color notes and matches primary', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await navigate(page, 'customizer');
      const header = page.getByRole('figure', { name: 'Light mode preview' }).locator('.bg-header');
      const background = () => header.evaluate(element => getComputedStyle(element).backgroundColor);
      const initial = await background();
      const field = page.getByLabel('Primary color hex code', { exact: true });
      const notes = await page.getByLabel('Color notes', { exact: true }).innerText();
      for (const value of ['#', '#2', '#2a', '#2a4', '#2a4b', '#2a4b8']) {
        await field.fill(value);
        assert.equal(await background(), initial, value);
        assert.equal(await page.getByLabel('Color notes', { exact: true }).innerText(), notes);
      }
      await field.fill('#2a4b8c');
      assert.notEqual(await background(), initial);
      await field.fill('#abc');
      await field.blur();
      assert.equal(await field.inputValue(), '#aabbcc');
      await field.fill('#f5c518');
      assert.match(await field.getAttribute('aria-describedby'), /theme-color-notes/);
      assert.match(await page.getByLabel('Primary color', { exact: true }).getAttribute('aria-describedby'), /theme-color-notes/);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      const branding = await (await page.request.get(`${base}/v1/branding`)).json();
      assert.deepEqual(branding.theme, { primary: '#f5c518' });
      // Unmatching starts from the primary on screen, not the accent from before the edit.
      await field.fill('#0f766e');
      await page.getByLabel('Match primary', { exact: true }).uncheck();
      const accent = page.getByLabel('Accent color hex code', { exact: true });
      assert.equal(await accent.inputValue(), '#0f766e');
      assert.equal(await page.getByLabel('Accent color', { exact: true }).inputValue(), '#0f766e');
      await accent.fill('#00aa44');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      assert.deepEqual((await (await page.request.get(`${base}/v1/branding`)).json()).theme, { primary: '#0f766e', accent: '#00aa44' });
    } finally { await context.close(); }
  });

  it('shows saved branding when the admin goes Back to the classroom, without a reload', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await page.goto(`${base}/lessons`);
      await page.getByRole('link', { name: 'plato — Lessons', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Admin Dashboard', exact: true }).click();
      await page.getByRole('link', { name: 'Customizer', exact: true }).click();
      await page.getByLabel('Classroom Name', { exact: true }).fill('Bauhaus Design Studio');
      await page.getByLabel('Primary color hex code', { exact: true }).fill('#1d4ed8');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      await page.goBack();
      await page.goBack();
      await page.waitForURL(`${base}/lessons`);
      await page.getByRole('link', { name: 'Bauhaus Design Studio — Lessons', exact: true }).waitFor();
      await page.waitForFunction(() => document.title.includes('Bauhaus Design Studio'));
      assert.equal(await page.getByRole('banner').evaluate(header => getComputedStyle(header).backgroundColor), 'rgb(29, 78, 216)');
      const icons = () => page.locator("link[rel='icon']").evaluateAll(links => links.map(link => link.href.startsWith('data:image/png') ? 'data:image/png' : new URL(link.href).pathname));
      const iconsAreGenerated = generated => page.waitForFunction(value => [...document.querySelectorAll("link[rel='icon']")].every(link => link.href.startsWith('data:') === value), generated);
      // Both favicon sizes follow the classroom, and the admin console keeps plato's.
      await iconsAreGenerated(true);
      assert.deepEqual(await icons(), ['data:image/png', 'data:image/png']);
      await page.getByRole('link', { name: 'Admin Dashboard', exact: true }).click();
      await page.locator('#main-content h1').waitFor();
      await iconsAreGenerated(false);
      // The build fingerprints the icons (icon-32-<hash>.png).
      const restored = await icons();
      assert.equal(restored.length, 2);
      assert.match(restored[0], /^\/assets\/icon-32\b[^/]*\.png$/);
      assert.match(restored[1], /^\/assets\/icon-16\b[^/]*\.png$/);
    } finally { await context.close(); }
  });

  it('isolates knowledge failures and retries from Styles, and Styles failures from knowledge', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      let calls = 0;
      await page.route('**/v1/admin/knowledge-base', route => {
        calls++;
        return route.fulfill({ status: calls === 1 ? 503 : 200, contentType: 'application/json', body: JSON.stringify(calls === 1 ? { error: 'Knowledge offline' } : { content: '# Ready' }) });
      });
      await navigate(page, 'customizer');
      await page.getByLabel('Classroom Name', { exact: true }).fill('Independent styles');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      await page.getByRole('tab', { name: 'Knowledge', exact: true }).click();
      await page.getByRole('button', { name: 'Retry knowledge base', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Knowledge Base', exact: true }).waitFor();
      await page.route('**/v1/admin/theme', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Styles offline"}' }));
      await navigate(page, 'customizer');
      await page.getByRole('button', { name: 'Retry styles', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Knowledge', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Knowledge Base', exact: true }).waitFor();
    } finally { await context.close(); }
  });

  it('renders Styles while the knowledge request is still pending', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    try {
      await page.route('**/v1/admin/knowledge-base', async route => { await gate; await route.fulfill({ contentType: 'application/json', body: '{}' }); });
      await page.goto(`${base}/plato/customizer`);
      await page.getByLabel('Primary color hex code', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Classroom Name', { exact: true }).isEditable(), true);
    } finally { finish(); await context.close(); }
  });

  it('preserves wordmarks in both previews, restores removal focus, and loads cached logos in the classroom', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await navigate(page, 'customizer');
      const dataUrl = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 300;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 160px sans-serif'; ctx.fillText('ACADEMY', 35, 210);
        return canvas.toDataURL('image/png');
      });
      const file = { name: 'wordmark.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') };
      await page.getByLabel('Classroom Name', { exact: true }).fill('Academy');
      await page.getByLabel('Logo image (optional)', { exact: true }).setInputFiles(file);
      await page.getByRole('button', { name: 'Remove logo image', exact: true }).waitFor();
      const images = page.locator('figure img');
      assert.equal(await images.count(), 2);
      for (const image of await images.all()) {
        const bounds = await image.evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight, displayWidth: img.getBoundingClientRect().width, displayHeight: img.getBoundingClientRect().height }));
        assert.deepEqual(bounds, { width: 512, height: 128, displayWidth: 128, displayHeight: 32 });
      }
      await page.getByRole('button', { name: 'Remove logo image', exact: true }).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'logo-file');
      assert.equal(await page.getByLabel('Logo image (optional)', { exact: true }).inputValue(), '');
      await page.getByLabel('Logo image (optional)', { exact: true }).setInputFiles(file);
      await page.getByRole('button', { name: 'Remove logo image', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      const assets = join(process.env.PLATO_TEST_ARTIFACT_DIR || join(root, 'output/playwright/customizer-2026-10-25'), browserName);
      await mkdir(assets, { recursive: true });
      await page.screenshot({ path: join(assets, 'styles-desktop-light.png'), fullPage: true });
      const palette = () => page.locator('figure button').evaluateAll(buttons => buttons.map(button => {
        const style = getComputedStyle(button); return [style.color, style.backgroundColor, style.borderColor];
      }));
      const lightPalette = await palette();
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
      assert.deepEqual(await palette(), lightPalette, 'preview button styles are independent of the outer theme');
      await page.screenshot({ path: join(assets, 'styles-desktop-dark.png'), fullPage: true });
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      await page.screenshot({ path: join(assets, 'styles-phone-dark.png'), fullPage: true });
      await page.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(assets, 'styles-phone-dark-actions.png'), fullPage: true });
      await page.getByRole('link', { name: 'Open the Classroom', exact: true }).click();
      const logo = page.getByRole('link', { name: 'Academy — Lessons', exact: true }).locator('img');
      await logo.waitFor();
      const source = await logo.getAttribute('src');
      assert.match(source, /^\/v1\/branding\/logo\/[a-f0-9]{64}$/);
      assert.equal(await logo.evaluate(img => img.complete && img.naturalWidth === 512), true);
    } finally { await context.close(); }
  });

  it('processes SVG files as bounded proportional PNGs and rejects oversize uploads', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await navigate(page, 'customizer');
      const fileInput = page.getByLabel('Logo image (optional)', { exact: true });
      await fileInput.setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 300"><rect width="1200" height="300" fill="#fff"/></svg>') });
      await page.getByRole('button', { name: 'Remove logo image', exact: true }).waitFor();
      assert.match(await page.locator('figure img').first().getAttribute('src'), /^data:image\/png;base64,/);
      assert.equal(await page.locator('figure img').first().evaluate(img => img.naturalWidth / img.naturalHeight), 4);
      await fileInput.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
      await page.getByRole('alert').filter({ hasText: '5 MiB' }).waitFor();
      assert.equal(await fileInput.inputValue(), '');
      assert.equal(await page.locator('figure img').count(), 2, 'a rejected upload preserves the previous logo');
    } finally { await context.close(); }
  });

  it('keeps failed saves dirty and ties the knowledge editor to its URL', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await page.route('**/v1/admin/knowledge-base', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ content: '# Knowledge', conversation: [{ role: 'assistant', content: 'Saved conversation' }] }) }));
      await page.route('**/v1/ai/**', route => route.abort());
      await navigate(page, 'customizer');
      await page.route('**/v1/admin/theme', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Save unavailable"}' }) : route.continue());
      await page.getByLabel('Classroom Name', { exact: true }).fill('Retain me');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Save unavailable' }).waitFor();
      assert.equal(await page.getByLabel('Classroom Name', { exact: true }).inputValue(), 'Retain me');
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await page.getByRole('tab', { name: 'Knowledge', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Knowledge Base', exact: true }).click();
      await page.waitForURL(`${base}/plato/customizer/knowledge/edit`);
      await page.getByRole('button', { name: 'Back to knowledge base', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Styles', exact: true }).click();
      await page.getByRole('tab', { name: 'Knowledge', exact: true }).click();
      await page.waitForURL(`${base}/plato/customizer/knowledge`);
      assert.equal(await page.getByRole('button', { name: 'Back to knowledge base', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Edit Knowledge Base', exact: true }).waitFor();
    } finally { await context.close(); }
  });

  it('saves the reviewed knowledge preview verbatim without another extraction', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    page.setDefaultTimeout(6000);
    const auth = JSON.parse(storageState.origins[0].localStorage.find(item => item.name === 'plato_auth').value);
    const headers = { Authorization: `Bearer ${auth.accessToken}` };
    const reviewed = '# Studio knowledge\n\n**Alt text** is required on 日本語 slides 🌱.\n\n> Review every image.\n\n```js\nconst policy = "alt text";\n```';
    const inference = [];
    try {
      const seed = await context.request.put(`${base}/v1/admin/knowledge-base`, {
        headers,
        data: { content: '# Saved knowledge\n\nThe existing program policy.', conversation: [{ role: 'assistant', content: 'What should change?' }], readiness: null },
      });
      assert.equal(seed.status(), 200);
      await page.route('**/v1/ai/messages', route => {
        const body = route.request().postDataJSON();
        inference.push(body);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: body.stream ? 'The policy is ready. [READINESS: 8]' : reviewed }] }) });
      });
      await page.goto(`${base}/plato/customizer/knowledge/edit`);
      const preview = page.getByRole('complementary', { name: 'Knowledge base markdown preview', exact: true });
      await preview.getByRole('note').filter({ hasText: 'This is the saved knowledge base.' }).waitFor();
      assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '8', 'saved content without readiness remains savable');
      assert.equal(await page.getByRole('button', { name: 'Update Knowledge Base', exact: true }).isEnabled(), true);
      assert.equal(await preview.getByText(/Review this preview/).count(), 0);
      await page.getByPlaceholder('Tell me about your program...', { exact: true }).fill('Require alt text on every slide.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await preview.getByRole('button', { name: 'Refresh preview', exact: true }).click();
      await preview.getByRole('note').filter({ hasText: 'Review this preview' }).waitFor();
      assert.equal(await preview.locator('pre code').textContent(), 'const policy = "alt text";');
      assert.equal(await preview.locator('blockquote').textContent(), 'Review every image.');
      assert.equal(inference.filter(body => !body.stream).length, 1);
      const assets = join(process.env.PLATO_TEST_ARTIFACT_DIR || join(root, 'output/playwright/customizer-validation-2026-10-26'), browserName);
      await mkdir(assets, { recursive: true });
      await page.screenshot({ path: join(assets, 'knowledge-reviewed-preview.png'), fullPage: true });
      await page.getByRole('tab', { name: 'Styles', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.screenshot({ path: join(assets, 'knowledge-unsaved-dialog.png'), fullPage: true });
      await page.getByRole('button', { name: 'Stay here', exact: true }).click();
      assert.equal(await page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }), true);
      await page.getByRole('button', { name: 'Update Knowledge Base', exact: true }).click();
      await page.waitForURL(`${base}/plato/customizer/knowledge`);
      const saved = await (await context.request.get(`${base}/v1/admin/knowledge-base`, { headers })).json();
      assert.equal(saved.content, reviewed, 'persist exactly the reviewed Unicode and Markdown');
      assert.equal(saved.conversation.some(message => message.unpublished), false);
      assert.equal(inference.length, 2, 'one conversation reply and one preview extraction; Save does not call AI');
      await page.locator('.coach-copy pre code').waitFor();
      await page.screenshot({ path: join(assets, 'knowledge-saved.png'), fullPage: true });
      await page.getByRole('tab', { name: 'Styles', exact: true }).click();
      await page.waitForURL(`${base}/plato/customizer`);
      assert.equal(await page.getByRole('alertdialog').count(), 0, 'a successful save clears the navigation guard');
    } finally { await context.close(); }
  });

  it('keeps unpublished knowledge drafts guarded after leaving and reopening the editor', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    page.setDefaultTimeout(6000);
    const auth = JSON.parse(storageState.origins[0].localStorage.find(item => item.name === 'plato_auth').value);
    const headers = { Authorization: `Bearer ${auth.accessToken}` };
    try {
      const seed = await context.request.put(`${base}/v1/admin/knowledge-base`, {
        headers,
        data: {
          content: '# Saved policy\n\nCohorts meet on Fridays.', readiness: 8,
          conversation: [{ role: 'assistant', content: 'Saved guide' }, { role: 'user', content: 'Move cohorts to Mondays.', unpublished: true }],
        },
      });
      assert.equal(seed.status(), 200);
      await page.route('**/v1/ai/**', route => route.abort());
      await page.goto(`${base}/plato/customizer/knowledge/edit`);
      const stale = page.getByText('The conversation has changed. Refresh the preview to include your changes.', { exact: true });
      await stale.waitFor();
      await page.getByRole('tab', { name: 'Styles', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: 'Leave without saving', exact: true }).click();
      await page.waitForURL(`${base}/plato/customizer`);
      await page.getByRole('tab', { name: 'Knowledge', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Knowledge Base', exact: true }).click();
      await stale.waitFor();
      assert.equal(await page.getByText('Move cohorts to Mondays.', { exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Back to knowledge base', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: 'Stay here', exact: true }).click();
      assert.equal(new URL(page.url()).pathname, '/plato/customizer/knowledge/edit');
      const saved = await (await context.request.get(`${base}/v1/admin/knowledge-base`, { headers })).json();
      assert.equal(saved.content, '# Saved policy\n\nCohorts meet on Fridays.');
      assert.equal(saved.conversation[1].unpublished, true);
    } finally { await context.close(); }
  });

  it('waits for pending knowledge drafts before publishing', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    page.setDefaultTimeout(6000);
    const auth = JSON.parse(storageState.origins[0].localStorage.find(item => item.name === 'plato_auth').value);
    const headers = { Authorization: `Bearer ${auth.accessToken}` };
    const reviewed = '# Published program policy\n\nCohorts meet on Mondays. The reviewed text must survive every pending draft write.';
    let releaseDraft;
    const gate = new Promise(resolve => { releaseDraft = resolve; });
    let announceHeld;
    const held = new Promise(resolve => { announceHeld = resolve; });
    let draftHeld = false;
    let publications = 0;
    try {
      const seed = await context.request.put(`${base}/v1/admin/knowledge-base`, {
        headers, data: { content: '# Program policy\n\nCohorts meet on Fridays.', conversation: [{ role: 'assistant', content: 'What should change?' }], readiness: 8 },
      });
      assert.equal(seed.status(), 200);
      await page.route('**/v1/ai/messages', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: route.request().postDataJSON().stream ? 'The policy is ready. [READINESS: 8]' : reviewed }] }) }));
      await page.route('**/v1/admin/knowledge-base/conversation', async route => {
        if (!draftHeld && route.request().postDataJSON().conversation.length === 3) {
          draftHeld = true;
          announceHeld();
          await gate;
        }
        await route.continue().catch(() => {});
      });
      await page.route('**/v1/admin/knowledge-base', route => {
        if (route.request().method() === 'PUT') publications++;
        return route.continue();
      });
      await page.goto(`${base}/plato/customizer/knowledge/edit`);
      await page.getByRole('note').filter({ hasText: 'This is the saved knowledge base.' }).waitFor();
      await page.getByPlaceholder('Tell me about your program...', { exact: true }).fill('Move cohorts to Mondays.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await held;
      await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
      await page.getByRole('note').filter({ hasText: 'Review this preview' }).waitFor();
      await page.getByRole('button', { name: 'Update Knowledge Base', exact: true }).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(publications, 0, 'publication must wait for the held draft, which could otherwise restore unpublished flags');
      await page.getByRole('tab', { name: 'Styles', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Leave without saving', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Stay here', exact: true }).click();
      releaseDraft();
      await page.waitForURL(`${base}/plato/customizer/knowledge`);
      const saved = await (await context.request.get(`${base}/v1/admin/knowledge-base`, { headers })).json();
      assert.equal(saved.content, reviewed);
      assert.equal(saved.conversation.length, 3);
      assert.equal(saved.conversation.some(message => message.unpublished), false);
      assert.equal(publications, 1);
      await page.getByRole('button', { name: 'Edit Knowledge Base', exact: true }).click();
      await page.getByRole('note').filter({ hasText: 'This is the saved knowledge base.' }).waitFor();
      await page.getByRole('tab', { name: 'Styles', exact: true }).click();
      await page.waitForURL(`${base}/plato/customizer`);
      assert.equal(await page.getByRole('alertdialog').count(), 0);
    } finally { releaseDraft(); await context.close(); }
  });

  for (const failRefresh of [false, true]) {
    it(`shows acknowledged knowledge while its refresh ${failRefresh ? 'fails' : 'is pending'} without redirecting later`, async () => {
      const { context, page } = await openPage({ width: 1440, height: 1000 });
      page.setDefaultTimeout(6000);
      const auth = JSON.parse(storageState.origins[0].localStorage.find(item => item.name === 'plato_auth').value);
      const headers = { Authorization: `Bearer ${auth.accessToken}` };
      const content = '# Acknowledged knowledge\n\nThis policy was saved before its metadata refresh.';
      let releaseRefresh;
      const gate = new Promise(resolve => { releaseRefresh = resolve; });
      let announceHeld;
      const held = new Promise(resolve => { announceHeld = resolve; });
      let published = false;
      let refreshHeld = false;
      try {
        const seed = await context.request.put(`${base}/v1/admin/knowledge-base`, {
          headers, data: { content, conversation: [{ role: 'assistant', content: 'Saved guide' }], readiness: 8 },
        });
        assert.equal(seed.status(), 200);
        await page.route('**/v1/ai/**', route => route.abort());
        await page.route('**/v1/admin/knowledge-base', async route => {
          if (route.request().method() === 'PUT') published = true;
          if (route.request().method() === 'GET' && published && !refreshHeld) {
            refreshHeld = true;
            announceHeld();
            await gate;
            if (failRefresh) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Metadata refresh unavailable"}' }).catch(() => {});
          }
          await route.continue().catch(() => {});
        });
        await page.goto(`${base}/plato/customizer/knowledge/edit`);
        await page.getByRole('note').filter({ hasText: 'This is the saved knowledge base.' }).waitFor();
        await page.getByRole('button', { name: 'Update Knowledge Base', exact: true }).click();
        await held;
        assert.equal(new URL(page.url()).pathname, '/plato/customizer/knowledge', 'acknowledged content must not wait for the refresh to navigate');
        await page.locator('.coach-copy').getByRole('heading', { name: 'Acknowledged knowledge', exact: true }).waitFor();
        await page.getByRole('tab', { name: 'Styles', exact: true }).click();
        await page.waitForURL(`${base}/plato/customizer`);
        const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/v1/admin/knowledge-base'));
        releaseRefresh();
        await refreshed;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(new URL(page.url()).pathname, '/plato/customizer', 'a completed refresh must never reclaim navigation');
        await page.getByRole('tab', { name: 'Knowledge', exact: true }).click();
        await page.locator('.coach-copy').getByRole('heading', { name: 'Acknowledged knowledge', exact: true }).waitFor();
      } finally { releaseRefresh(); await context.close(); }
    });
  }

  it('keeps rendered brand fills visible against light and tinted dark surfaces', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    page.setDefaultTimeout(6000);
    let primary;
    try {
      await page.route('**/v1/branding', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ classroomName: 'Contrast Studio', theme: { primary } }) }));
      for (primary of ['#f8fafc', '#bae6fd', '#eab308', '#1d4ed8']) {
        await page.goto(`${base}/lessons`);
        await page.getByRole('link', { name: 'Contrast Studio — Lessons', exact: true }).waitFor();
        for (const mode of ['light', 'dark']) {
          const ratios = await page.evaluate(theme => {
            document.documentElement.classList.toggle('dark', theme === 'dark');
            const probe = document.createElement('span');
            document.querySelector('div.classroom-theme').append(probe);
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const luminance = token => {
              probe.style.backgroundColor = `var(${token})`;
              ctx.fillStyle = getComputedStyle(probe).backgroundColor;
              ctx.fillRect(0, 0, 1, 1);
              const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
              return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
            };
            const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            const fill = luminance('--primary');
            const results = {
              card: ratio(fill, luminance('--card')),
              dialog: ratio(fill, luminance('--popover')),
              progress: ratio(luminance('--primary-text'), luminance('--muted')),
              text: ratio(fill, luminance('--primary-foreground')),
            };
            probe.remove();
            return results;
          }, mode);
          for (const [surface, ratio] of Object.entries(ratios)) {
            assert.ok(ratio >= (surface === 'text' ? 4.5 : 3), `${primary} ${mode} ${surface}: ${ratio.toFixed(3)}:1`);
          }
        }
      }
    } finally { await context.close(); }
  });

  it('follows device changes until the visitor chooses a theme', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 }, null, 'dark');
    try {
      await navigate(page, 'customizer');
      assert.equal(await page.locator('html').evaluate(element => element.classList.contains('dark')), true);
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.emulateMedia({ colorScheme: 'light' });
      assert.equal(await page.locator('html').evaluate(element => element.classList.contains('dark')), true);
      assert.equal(await page.evaluate(() => localStorage.getItem('plato_theme')), 'dark');
    } finally { await context.close(); }
  });

  it('accepts bounded JPEG and WebP API logos and renders a legacy SVG favicon safely', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await navigate(page, 'customizer');
      const auth = JSON.parse(storageState.origins[0].localStorage.find(item => item.name === 'plato_auth').value);
      const writeLogo = logoBase64 => fetch(`${base}/v1/admin/theme`, {
        method: 'PUT', headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ logoBase64, classroomName: 'Vector Academy' }),
      });
      for (const mime of ['image/jpeg', 'image/webp']) {
        const data = await page.evaluate(type => {
          const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 100;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 400, 100);
          return canvas.toDataURL(type);
        }, mime);
        assert.equal((await writeLogo(data)).status, 200, mime);
      }
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><path fill="#fff" d="M0 0h400v100H0z"/></svg>';
      assert.equal((await writeLogo(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)).status, 200);
      await page.goto(`${base}/lessons`);
      const logo = page.getByRole('link', { name: 'Vector Academy — Lessons', exact: true }).locator('img');
      await logo.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('link[rel="icon"]')].some(link => link.href.startsWith('data:image/png')), null, { timeout: 5000 })
        .catch(async () => assert.fail(`SVG favicon did not load: ${errors.join('; ')}; image: ${JSON.stringify(await logo.evaluate(img => ({ complete: img.complete, width: img.naturalWidth, height: img.naturalHeight })))}`));
      assert.equal(await logo.evaluate(img => img.complete && img.naturalWidth > 0), true);
      const pixel = await page.evaluate(async () => {
        const image = new Image();
        image.src = [...document.querySelectorAll('link[rel="icon"]')].find(link => link.href.startsWith('data:image/png')).href;
        await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(5, 16, 1, 1).data];
      });
      assert.deepEqual(pixel, [255, 255, 255, 255], 'favicon includes the SVG wordmark, rather than just the background or initial');
    } finally { await context.close(); }
  });
});
