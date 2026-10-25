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
});
