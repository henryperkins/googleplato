// Browser checks for the learner's lesson list (/lessons): where focus goes
// when paging, the lesson card's focus ring, Start here, and the progress
// bars' colors. Runs against the isolated learner fixture (SQLite, synthetic
// learners); build the client first with `npm run build:client`.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { contrastRatio } from '../../src/lib/branding.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const engine = process.env.PLATO_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const assets = process.env.PLATO_TEST_CLIENT_DIST || join(root, 'client/dist');
const password = randomBytes(24).toString('base64url');
let browser, server, directory, base;

// The fixture's learner a has 13 of 14 lessons in progress (two pages) and
// one completed; its admin has started none.
async function signIn(who, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.getByRole('textbox', { name: 'Email or Username' }).fill(`learner-${who}@example.test`);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/lessons');
  await page.getByRole('button', { name: /^Open lesson / }).first().waitFor();
  return { context, page };
}
const focused = page => page.evaluate(() => {
  const element = document.activeElement;
  return { tag: element.tagName, name: element.getAttribute('aria-label') || element.textContent.trim() };
});
const pageLabel = page => page.getByRole('navigation', { name: 'Lessons pagination' }).locator('span').textContent();
// A progress bar's colors as painted: its surface, then the track and fill
// over it. CanvasText is resolved for comparison.
const barColors = bar => bar.evaluate((track) => {
  const paint = (...layers) => {
    const context = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
    for (const color of layers) { context.fillStyle = color; context.fillRect(0, 0, 1, 1); }
    return '#' + [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(c => c.toString(16).padStart(2, '0')).join('');
  };
  let surface = 'white';
  for (let node = track.parentElement; node; node = node.parentElement) {
    const background = getComputedStyle(node).backgroundColor;
    if (background !== 'rgba(0, 0, 0, 0)') { surface = background; break; }
  }
  const probe = document.body.appendChild(document.createElement('span'));
  const resolve = (color) => { probe.style.color = color; return getComputedStyle(probe).color; };
  const colors = {
    surface: paint(surface),
    track: paint(surface, getComputedStyle(track).backgroundColor),
    fill: paint(surface, getComputedStyle(track.firstElementChild).backgroundColor),
    text: paint(resolve('CanvasText')),
    outline: getComputedStyle(track).outlineStyle,
  };
  probe.remove();
  return colors;
});
// The track stands off its surface and the fill off the track.
const assertVisible = (colors, where) => {
  assert.ok(contrastRatio(colors.track, colors.surface) >= 1.3, `${where}: track ${colors.track} on ${colors.surface}`);
  assert.ok(contrastRatio(colors.fill, colors.track) >= 3, `${where}: fill ${colors.fill} on ${colors.track}`);
};

describe(`lesson list (${engine})`, () => {
  before(async () => {
    assert.ok(existsSync(join(assets, 'index.html')), 'Build the client before browser tests');
    directory = await mkdtemp(join(tmpdir(), 'plato-lessons-'));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['client/tests/browser/fixtures/learner-server.mjs'], {
      cwd: root,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), DB_BACKEND: 'sqlite', SQLITE_PATH: join(directory, 'test.db'),
        APP_URL: base, JWT_SECRET: randomBytes(32).toString('hex'), PLATO_TEST_PASSWORD: password, PLATO_TEST_CLIENT_DIST: resolve(assets), SKIP_EMAIL: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-12000); };
    server.stdout.on('data', collect); server.stderr.on('data', collect);
    const started = Date.now();
    while (true) {
      assert.equal(server.exitCode, null, `Fixture stopped: ${output}`);
      try { if ((await fetch(`${base}/v1/auth/setup-status`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* bounded startup */ }
      assert.ok(Date.now() - started < 15000, `Fixture startup timed out: ${output}`);
      await delay(100);
    }
    browser = await (engine === 'webkit' ? webkit : chromium).launch();
  });

  after(async () => {
    await browser?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 3000); timer.unref();
      try { await exited; } finally { clearTimeout(timer); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('moves focus to the heading when paging, and never drops it on a disabled button', async () => {
    const { context, page } = await signIn('a');
    const previous = page.getByRole('button', { name: 'Previous page' });
    const next = page.getByRole('button', { name: 'Next page' });
    assert.equal(await previous.getAttribute('aria-disabled'), 'true', 'disabled, but still focusable');

    await next.focus();
    await page.keyboard.press('Enter');
    assert.equal(await pageLabel(page), 'Page 2 of 2');
    assert.deepEqual(await focused(page), { tag: 'H1', name: 'Lessons' });
    assert.ok(await page.evaluate(() => scrollY) < 100, 'the new page starts at the top');

    // Next is disabled on the last page; pressing it keeps focus where it is.
    await next.focus();
    await page.keyboard.press('Enter');
    assert.equal(await pageLabel(page), 'Page 2 of 2');
    assert.deepEqual(await focused(page), { tag: 'BUTTON', name: 'Next page' });

    await page.keyboard.press('Shift+Tab');
    assert.deepEqual(await focused(page), { tag: 'BUTTON', name: 'Previous page' });
    await page.keyboard.press('Enter');
    assert.equal(await pageLabel(page), 'Page 1 of 2');
    assert.deepEqual(await focused(page), { tag: 'H1', name: 'Lessons' });
    await context.close();
  });

  it('rings the whole card while its open action has keyboard focus', async () => {
    const { context, page } = await signIn('a');
    await page.locator('#status-filter').focus();
    await page.keyboard.press('Tab');
    const ring = () => page.evaluate(() => {
      const control = document.activeElement;
      const card = control.closest('[data-slot=card]');
      const cardStyle = getComputedStyle(card);
      return { control: control.textContent.trim().slice(0, 12), button: getComputedStyle(control).outlineStyle,
        card: cardStyle.outlineStyle === 'none' ? 'none' : `${cardStyle.outlineStyle} ${cardStyle.outlineWidth}` };
    });
    assert.deepEqual(await ring(), { control: 'Give constru', button: 'none', card: 'solid 3px' });
    // View outline, inside the same card, keeps its own ring.
    await page.keyboard.press('Tab');
    assert.deepEqual(await ring(), { control: 'View outline', button: 'solid', card: 'none' });
    await context.close();
  });

  it('marks Start here on the first lesson only for a learner who has started nothing', async () => {
    const fresh = await signIn('admin');
    const cards = fresh.page.getByRole('button', { name: /^Open lesson / });
    assert.match(await cards.first().getAttribute('aria-label'), /\. Not started\. Start here\.$/);
    assert.equal(await fresh.page.getByRole('button', { name: /Start here\.$/ }).count(), 1);
    await fresh.context.close();

    const returning = await signIn('a');
    assert.equal(await returning.page.getByRole('button', { name: /Start here\.$/ }).count(), 0);
    await returning.context.close();
  });

  it('shows each progress bar whole in both themes, and keeps the bars in forced colors', async () => {
    const courseBar = page => page.getByRole('progressbar', { name: /progress: 1 of 14 public lessons completed$/ });
    // A status filter keeps the course grouping, so the course's bar leads.
    const showInProgress = page => page.locator('#status-filter').selectOption('in-progress');
    const outlineBar = async (page) => {
      await page.getByRole('button', { name: 'View outline' }).first().click();
      return page.getByRole('dialog').getByRole('progressbar', { name: '30% complete' });
    };

    for (const theme of ['light', 'dark']) {
      const { context, page } = await signIn('a');
      if (theme === 'dark') {
        await page.evaluate(() => localStorage.setItem('plato_theme', 'dark'));
        await page.reload();
        await page.getByRole('button', { name: /^Open lesson / }).first().waitFor();
      }
      await showInProgress(page);
      assertVisible(await barColors(courseBar(page)), `${theme} course bar`);
      assertVisible(await barColors(await outlineBar(page)), `${theme} outline bar`);
      await context.close();
    }

    // Forced colors drop fills: the track keeps an outline, the fill takes
    // the text color. WebKit has no forced colors mode.
    if (engine === 'webkit') return;
    const { context, page } = await signIn('a', { forcedColors: 'active' });
    await showInProgress(page);
    for (const bar of [courseBar(page), await outlineBar(page)]) {
      const colors = await barColors(bar);
      assert.equal(colors.outline, 'solid');
      assert.equal(colors.fill, colors.text);
      assert.notEqual(colors.fill, colors.track);
    }
    await context.close();
  });
});
