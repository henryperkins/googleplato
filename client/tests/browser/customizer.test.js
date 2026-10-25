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
import Database from 'better-sqlite3';

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
      const notes = await page.locator('#theme-color-notes').innerText();
      for (const value of ['#', '#2', '#2a', '#2a4', '#2a4b', '#2a4b8']) {
        await field.fill(value);
        assert.equal(await background(), initial, value);
        assert.equal(await page.locator('#theme-color-notes').innerText(), notes);
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
      await page.getByLabel('Match primary', { exact: true }).uncheck();
      await page.getByLabel('Accent color hex code', { exact: true }).fill('#00aa44');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      assert.equal((await (await page.request.get(`${base}/v1/branding`)).json()).theme.accent, '#00aa44');
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
      const assets = join(root, `output/playwright/customizer-2026-10-25/${browserName}`);
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
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#fff" d="M0 0h100v100H0z"/></svg>';
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
      assert.deepEqual(pixel, [255, 255, 255, 255], 'favicon includes the SVG logo, rather than just the background or initial');
    } finally { await context.close(); }
  });

  it('saves on the first press after a shorthand hex, although committing it reflows the notes', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await navigate(page, 'customizer');
      await page.getByLabel('Primary color hex code', { exact: true }).fill('#fff');
      const box = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await delay(80);
      await page.mouse.up();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor({ timeout: 5000 });
      assert.equal((await (await page.request.get(`${base}/v1/branding`)).json()).theme.primary, '#ffffff');
      assert.equal(await page.getByLabel('Primary color hex code', { exact: true }).inputValue(), '#ffffff');
    } finally { await context.close(); }
  });

  it('describes the color fields with the notes, keeps preview samples out of the tab order, and unmatches from the shown color', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await navigate(page, 'customizer');
      const primary = page.getByLabel('Primary color hex code', { exact: true });
      await primary.fill('#f5c518');
      await page.locator('#theme-color-notes li').first().waitFor();
      if (browserName === 'chromium') {
        const { nodes } = await (await context.newCDPSession(page)).send('Accessibility.getFullAXTree');
        const field = nodes.find(node => node.name?.value === 'Primary color hex code');
        assert.match(field?.description?.value || '', /Warning: In light mode.*barely stand out from white/);
      }
      for (const sample of await page.locator('figure button').all()) {
        assert.equal(await sample.evaluate(element => { element.focus(); return document.activeElement === element; }), false);
      }
      await primary.fill('#2a4b8c');
      await page.getByLabel('Match primary', { exact: true }).uncheck();
      assert.equal(await page.getByLabel('Accent color hex code', { exact: true }).inputValue(), '#2a4b8c');
      await page.getByLabel('Accent color hex code', { exact: true }).fill('2A4B8C');
      await page.getByLabel('Accent color hex code', { exact: true }).blur();
      assert.equal(await page.getByLabel('Accent color hex code', { exact: true }).inputValue(), '#2a4b8c');
      await page.getByLabel('Match primary', { exact: true }).check();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      await page.getByLabel('Match primary', { exact: true }).uncheck();
      await page.getByLabel('Accent color hex code', { exact: true }).fill('#123456');
      await page.getByLabel('Match primary', { exact: true }).check();
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true, 'a matched accent is not an edit');
    } finally { await context.close(); }
  });

  it('keeps a logo from an earlier version and optimizes its square padding away', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await navigate(page, 'customizer');
      const padded = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#123456'; ctx.fillRect(16, 196, 480, 120);
        return canvas.toDataURL('image/png');
      });
      const sqlite = new Database(join(directory, 'test.sqlite'));
      try {
        sqlite.prepare("UPDATE sync_data SET data = json_set(json_remove(data, '$.logoHash'), '$.logoBase64', ?, '$.classroomName', 'Legacy Academy') WHERE userId = '_system' AND dataKey = 'settings'").run(padded);
      } finally { sqlite.close(); }
      const before = await (await page.request.get(`${base}/v1/branding`)).json();
      assert.match(before.logoUrl, /^\/v1\/branding\/logo\/[a-f0-9]{64}$/, 'learners still see it');
      await navigate(page, 'customizer');
      await page.getByText('An earlier version of plato padded this logo', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Optimize logo', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Logo optimized.' }).waitFor();
      assert.deepEqual(await page.locator('figure img').first().evaluate(img => [img.naturalWidth, img.naturalHeight]), [480, 120]);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Optimize logo', exact: true }).count(), 0);
      const after = await (await page.request.get(`${base}/v1/branding`)).json();
      assert.notEqual(after.logoUrl, before.logoUrl);
      assert.equal((await page.request.get(`${base}${before.logoUrl}`)).status(), 404, 'the replaced logo is removed');
      const png = Buffer.from(await (await page.request.get(`${base}${after.logoUrl}`)).body());
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [480, 120]);
    } finally { await context.close(); }
  });

  it('shows the classroom name when the logo cannot load, and keeps focus on retry', async () => {
    const { context, page } = await openPage({ width: 1440, height: 1000 });
    try {
      await navigate(page, 'customizer');
      await page.getByLabel('Classroom Name', { exact: true }).fill('Fallback Academy');
      await page.getByLabel('Logo image (optional)', { exact: true }).setInputFiles({ name: 'mark.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>') });
      await page.getByRole('status').filter({ hasText: 'Logo ready.' }).waitFor();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
      await page.route('**/v1/branding/logo/**', route => route.fulfill({ status: 503, body: '' }));
      await page.goto(`${base}/lessons`);
      const home = page.getByRole('link', { name: 'Fallback Academy — Lessons', exact: true });
      await home.getByText('Fallback Academy', { exact: true }).waitFor();
      assert.equal(await home.locator('img').count(), 0);
      let failed = false;
      await page.route('**/v1/admin/theme', route => {
        if (failed) return route.continue();
        failed = true;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Styles offline"}' });
      });
      await navigate(page, 'customizer');
      await page.getByRole('button', { name: 'Retry styles', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByLabel('Classroom Name', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H1');
    } finally { await context.close(); }
  });

  it('follows device changes on a public page that has no theme control', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
    try {
      const page = await context.newPage();
      await page.goto(`${base}/forgot-password`);
      await page.locator('main').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Dark mode', exact: true }).count(), 0);
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 3000 });
    } finally { await context.close(); }
  });
});
