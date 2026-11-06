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
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
const evidence = process.env.PLATO_TEST_EVIDENCE;
const password = randomBytes(24).toString('base64url');
let browser, server, directory, base;

// The fixture's learner a has 13 of 14 lessons in progress (two pages) and
// one completed; its admin has started none.
async function signIn(who, options = {}, prepare = async () => {}, { waitForCards = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  await prepare(page);
  await page.goto(`${base}/login`);
  await page.getByRole('textbox', { name: 'Email or Username' }).fill(`learner-${who}@example.test`);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/lessons');
  if (waitForCards) await page.getByRole('button', { name: /^Open lesson / }).first().waitFor();
  return { context, page };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const progressRequest = /\/v1\/sync\/lessonKB(?:%3A|:)/i;
const cards = page => page.getByRole('button', { name: /^Open lesson / });
const cardSnapshots = async locator => Promise.all((await locator.all()).map(card => card.ariaSnapshot()));
const refresh = async page => {
  const catalog = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/lessons');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await catalog;
};
const screenshot = async (page, name) => {
  if (evidence) await page.screenshot({ path: join(evidence, `${engine}-${name}.png`) });
};
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

describe(`lesson list (${engine})`, { timeout: 120000 }, () => {
  before(async () => {
    assert.ok(existsSync(join(assets, 'index.html')), 'Build the client before browser tests');
    if (evidence) await mkdir(evidence, { recursive: true });
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
      return { control: control.querySelector('span[dir=auto]')?.textContent.trim().slice(0, 12) ?? control.textContent.trim().slice(0, 12), button: getComputedStyle(control).outlineStyle,
        card: cardStyle.outlineStyle === 'none' ? 'none' : `${cardStyle.outlineStyle} ${cardStyle.outlineWidth}` };
    });
    // Learner a's lessons in progress lead the whole list (All statuses).
    assert.deepEqual(await ring(), { control: 'Give constru', button: 'none', card: 'solid 3px' });
    // View outline, inside the same card, keeps its own ring.
    await page.keyboard.press('Tab');
    assert.deepEqual(await ring(), { control: 'View outline', button: 'solid', card: 'none' });
    await context.close();
  });

  it('leads the whole list with lessons in progress, ahead of the course that sorts first', async () => {
    const { context, page } = await signIn('a');
    try {
      // Getting Started sorts first, but learner a's 13 lessons in progress
      // lead: twelve fill page one, the thirteenth opens page two.
      const inProgress = page.getByRole('list', { name: 'Lessons in progress' });
      assert.equal(await inProgress.getByRole('button', { name: /^Open lesson / }).count(), 12);
      assert.equal(await cards(page).count(), 12);
      assert.equal(await page.getByRole('heading', { name: 'Getting Started with plato', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await inProgress.getByRole('button', { name: /^Open lesson Practice giving thoughtful/ }).waitFor();
      assert.deepEqual((await page.getByRole('heading', { level: 2 }).allTextContents()).slice(0, 2), ['In progress', 'Getting Started with plato']);
      // A status filter keeps plain hierarchy order and grouping.
      await page.locator('#status-filter').selectOption('in-progress');
      await page.getByRole('list', { name: 'Lessons in progress' }).waitFor({ state: 'detached' });
      assert.match(await cards(page).first().getAttribute('aria-label') ?? await cards(page).first().textContent(), /Give constructive feedback/);
    } finally { await context.close(); }
  });

  it('marks Start here on the first lesson only for a learner who has started nothing', async () => {
    const fresh = await signIn('admin');
    const cards = fresh.page.getByRole('button', { name: /^Open lesson / });
    assert.match(await cards.first().ariaSnapshot(), /Start here\.[\s\S]*Not started/);
    assert.equal(await fresh.page.getByRole('button', { name: /Start here\./ }).count(), 1);
    await fresh.context.close();

    const returning = await signIn('a');
    assert.equal(await returning.page.getByRole('button', { name: /Start here\./ }).count(), 0);
    await returning.context.close();
  });

  it('waits for verified progress after a failed bulk sync before showing cards or Start here', async t => {
    const fallback = deferred();
    const reached = deferred();
    const { context, page } = await signIn('a', {}, async page => {
      await page.route('**/v1/sync', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
      await page.route(progressRequest, async route => {
        reached.resolve();
        await fallback.promise;
        await route.continue().catch(() => {});
      });
    }, { waitForCards: false });
    t.after(async () => { fallback.resolve(); await context.close(); });
    await reached.promise;
    assert.equal(await cards(page).count(), 0, 'unknown progress must not render an incorrect, focusable catalog');
    assert.equal(await page.getByText('Start here', { exact: true }).count(), 0);
    await page.getByText('Loading lessons…', { exact: true }).waitFor();
    await screenshot(page, 'progress-loading');
    fallback.resolve();
    const first = page.getByRole('button', { name: /^Open lesson Give constructive feedback/ });
    await first.waitFor();
    assert.match(await first.ariaSnapshot(), /^- button "Open lesson Give constructive feedback[\s\S]*In progress, 30% complete/);
    assert.equal(await page.getByText('Start here', { exact: true }).count(), 0);
    await page.locator('#status-filter').focus();
    await page.keyboard.press('Tab');
    await page.waitForLoadState('networkidle');
    assert.equal(await cards(page).first().evaluate(button => button === document.activeElement), true);
    await screenshot(page, 'progress-recovered');
  });

  it('shows a retry when fallback progress also fails, then recovers without inventing a first lesson', async t => {
    let failing = true;
    const { context, page } = await signIn('a', { viewport: { width: 390, height: 844 } }, async page => {
      await page.route('**/v1/sync', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
      await page.route(progressRequest, route => failing
        ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
        : route.continue());
    }, { waitForCards: false });
    t.after(() => context.close());
    await page.getByRole('alert').filter({ hasText: 'lesson progress' }).waitFor({ timeout: 3000 });
    await screenshot(page, 'progress-retry-390');
    assert.equal(await cards(page).count(), 0);
    assert.equal(await page.getByText('Start here', { exact: true }).count(), 0);
    failing = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    const recovered = page.getByRole('button', { name: /^Open lesson Give constructive feedback/ });
    await recovered.waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.match(await recovered.ariaSnapshot(), /In progress, 30% complete/);
  });

  it('keeps loading after an initial catalog failure while retry progress is pending', async t => {
    let catalogFailed = true;
    const fallback = deferred();
    const reached = deferred();
    const { context, page } = await signIn('a', {}, async page => {
      await page.route('**/v1/sync', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
      await page.route('**/v1/lessons', route => catalogFailed
        ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
        : route.continue());
      await page.route(progressRequest, async route => {
        reached.resolve();
        await fallback.promise;
        await route.continue().catch(() => {});
      });
    }, { waitForCards: false });
    t.after(async () => { fallback.resolve(); await context.close(); });
    await page.getByRole('alert').filter({ hasText: 'load your lessons' }).waitFor();
    catalogFailed = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await reached.promise;
    assert.equal(await page.getByText(/^No lessons yet\./).count(), 0,
      'a failed initial catalog is not a verified empty list');
    assert.equal(await cards(page).count(), 0);
    assert.doesNotMatch((await page.getByRole('status').allTextContents()).join(' '), /No lessons yet/);
    await page.getByText('Loading lessons…', { exact: true }).waitFor();
    await screenshot(page, 'catalog-retry-loading');
    fallback.resolve();
    const recovered = page.getByRole('button', { name: /^Open lesson Give constructive feedback/ });
    await recovered.waitFor();
    assert.match(await recovered.ariaSnapshot(), /In progress, 30% complete/);
    assert.equal(await page.getByRole('alert').count(), 0);
  });

  it('shows a verified empty catalog even when bulk progress is unavailable', async t => {
    const { context, page } = await signIn('a', {}, async page => {
      await page.route('**/v1/sync', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
      await page.route('**/v1/lessons', route => route.fulfill({ json: [] }));
    }, { waitForCards: false });
    t.after(() => context.close());
    await page.getByText(/^No lessons yet\./).last().waitFor();
    assert.equal(await page.getByText('Loading lessons…', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await cards(page).count(), 0);
    assert.match((await page.getByRole('status').allTextContents()).join(' '), /No lessons yet/);
  });

  it('uses a fresh bulk snapshot immediately and makes no per-lesson confirmation requests', async t => {
    let refreshed = false;
    let perLessonReads = 0;
    const blocked = deferred();
    const { context, page } = await signIn('a', {}, async page => {
      await page.route('**/v1/sync', async route => {
        const response = await route.fetch();
        const records = await response.json();
        const keys = new Set(refreshed ? ['lessonKB:feedback', 'lessonKB:long-title'] : ['lessonKB:feedback']);
        await route.fulfill({ response, json: records.filter(item => !item.dataKey.startsWith('lessonKB:') || keys.has(item.dataKey)) });
      });
      await page.route(progressRequest, async route => {
        perLessonReads++;
        if (refreshed) await blocked.promise;
        const dataKey = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
        await route.fulfill({ json: { dataKey, data: null, version: 0 } }).catch(() => {});
      });
    });
    t.after(async () => { blocked.resolve(); await context.close(); });
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('button', { name: /^Open lesson .*In progress, 30% complete/ }).count(), 1);
    refreshed = true;
    await refresh(page);
    await page.locator('#status-filter').selectOption('in-progress');
    await page.getByRole('button', { name: /^Open lesson Practice giving thoughtful.* In progress/ }).waitFor({ timeout: 3000 });
    assert.equal(perLessonReads, 0, 'successful bulk sync already knows which lessons have no progress record');
    await screenshot(page, 'fresh-bulk-progress');
  });

  it('keeps the verified catalog and keyboard focus during a failed foreground progress refresh', async t => {
    let failing = false;
    const reached = deferred();
    const release = deferred();
    const { context, page } = await signIn('a', {}, async page => {
      await page.route('**/v1/sync', async route => {
        if (failing) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
        const response = await route.fetch();
        const records = await response.json();
        return route.fulfill({ response, json: records.filter(item => !item.dataKey.startsWith('lessonKB:') || item.dataKey === 'lessonKB:feedback') });
      });
      await page.route(progressRequest, async route => {
        reached.resolve();
        await release.promise;
        await route.fulfill({ status: 503, json: { error: 'Unavailable' } }).catch(() => {});
      });
    });
    t.after(async () => { release.resolve(); await context.close(); });
    await page.waitForLoadState('networkidle');
    const before = await cardSnapshots(cards(page));
    await page.locator('#status-filter').focus();
    await page.keyboard.press('Tab');
    failing = true;
    await refresh(page);
    await reached.promise;
    assert.deepEqual(await cardSnapshots(cards(page)), before);
    assert.equal(await cards(page).first().evaluate(button => button === document.activeElement), true);
    release.resolve();
    await page.getByRole('alert').filter({ hasText: 'lesson progress' }).waitFor();
    assert.deepEqual(await cardSnapshots(cards(page)), before);
    assert.equal(await cards(page).first().evaluate(button => button === document.activeElement), true);
    failing = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'detached' });
    assert.deepEqual(await cardSnapshots(cards(page)), before);
  });

  it('does not let a superseded fallback overwrite a successful refresh or drop focus', async t => {
    let refreshed = false;
    let fallbackReads = 0;
    const reached = deferred();
    const release = deferred();
    const { context, page } = await signIn('a', {}, async page => {
      await page.route('**/v1/sync', async route => {
        if (!refreshed) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
        const response = await route.fetch();
        const records = await response.json();
        return route.fulfill({ response, json: records.filter(item => !item.dataKey.startsWith('lessonKB:') || item.dataKey === 'lessonKB:long-title') });
      });
      await page.route(progressRequest, async route => {
        fallbackReads++;
        reached.resolve();
        const response = await route.fetch();
        await release.promise;
        await route.fulfill({ response }).catch(() => {});
      });
    }, { waitForCards: false });
    t.after(async () => { release.resolve(); await context.close(); });
    await reached.promise;
    refreshed = true;
    await refresh(page);
    await page.locator('#status-filter').selectOption('in-progress');
    const current = page.getByRole('button', { name: /^Open lesson Practice giving thoughtful.* In progress/ });
    await current.waitFor();
    await current.focus();
    release.resolve();
    await page.waitForLoadState('networkidle');
    assert.equal(fallbackReads, 1, 'cancelled catalog reads stop before the next lesson');
    assert.equal(await current.evaluate(button => button === document.activeElement), true);
    assert.equal(await cards(page).first().ariaSnapshot(), await current.ariaSnapshot());
    assert.equal(await page.getByRole('alert').count(), 0);
  });

  it('cancels a pending completion read when the list unmounts', async t => {
    let completing = false;
    const reached = deferred();
    const release = deferred();
    const { context, page } = await signIn('a', {}, async page => {
      await page.route('**/v1/sync', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
      await page.route(progressRequest, async route => {
        if (!completing) return route.continue();
        reached.resolve();
        const response = await route.fetch();
        await release.promise;
        await route.fulfill({ response }).catch(() => {});
      });
    });
    t.after(async () => { release.resolve(); await context.close(); });
    completing = true;
    const aborted = page.waitForEvent('requestfailed', { predicate: request => progressRequest.test(request.url()), timeout: 5000 });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('plato:lesson-completed', { detail: { lessonId: 'feedback' } })));
    await reached.promise;
    await page.getByRole('button', { name: /^Open lesson Give constructive feedback/ }).click();
    await page.waitForURL('**/lessons/feedback');
    const request = await aborted;
    assert.match(request.failure().errorText, /abort|cancel/i);
    release.resolve();
    await page.getByRole('textbox', { name: 'Your message', exact: true }).waitFor();
  });

  it('does not reuse the previous account\'s catalog or hydration when signing in again', async t => {
    const { context, page } = await signIn('a');
    const reached = deferred();
    const release = deferred();
    t.after(async () => { release.resolve(); await context.close(); });
    await page.getByRole('button', { name: /— Account/ }).click();
    await page.getByRole('menuitem', { name: 'Sign Out', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign Out', exact: true }).click();
    await page.waitForURL('**/login');
    await page.route('**/v1/sync', async route => {
      reached.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    await page.getByRole('textbox', { name: 'Email or Username' }).fill('learner-admin@example.test');
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/lessons');
    await reached.promise;
    assert.equal(await cards(page).count(), 0);
    await page.getByText('Loading lessons…', { exact: true }).waitFor();
    release.resolve();
    await page.getByRole('button', { name: /Start here\./ }).waitFor();
    assert.equal(await page.getByRole('button', { name: /In progress,/ }).count(), 0);
  });

  it("lines up card titles across a row, each status mark on its title's first line", async () => {
    // With nothing started, Start here sits beside the first title, which wraps.
    const { context, page } = await signIn('admin');
    const rows = await page.evaluate(() => {
      const byRow = new Map();
      for (const item of document.querySelectorAll('ul[aria-label] > li')) {
        const title = item.querySelector('.lesson-open span[dir=auto]');
        const mark = title.parentElement.nextElementSibling;
        const box = title.getBoundingClientRect();
        const key = `${item.parentElement.getAttribute('aria-label')} ${Math.round(item.getBoundingClientRect().top)}`;
        if (!byRow.has(key)) byRow.set(key, []);
        byRow.get(key).push({ title: box.top, mark: mark.getBoundingClientRect().top,
          lines: Math.round(box.height / parseFloat(getComputedStyle(title).lineHeight)) });
      }
      return [...byRow.values()];
    });
    assert.ok(rows.some(row => row.length > 1 && row.some(card => card.lines > 1)), 'a row with a wrapped title');
    for (const row of rows) {
      const tops = row.map(card => card.title);
      assert.ok(Math.max(...tops) - Math.min(...tops) < 0.5, `titles share a top line: ${tops.join(', ')}`);
      for (const card of row) assert.ok(Math.abs(card.mark - card.title) < 0.5, `mark ${card.mark} on the title's first line ${card.title}`);
    }
    await context.close();
  });

  it('shows each progress bar whole in both themes, and keeps the bars in forced colors', async () => {
    const courseBar = page => page.getByRole('progressbar', { name: 'Getting Started with plato progress: 0 of 3 public lessons completed' });
    const outlineBar = async (page) => {
      const open = page.getByRole('button', { name: /^Open lesson Give constructive feedback/ });
      await page.getByRole('listitem').filter({ has: open }).getByRole('button', { name: 'View outline' }).click();
      return page.getByRole('dialog').getByRole('progressbar', { name: '30% complete' });
    };
    // Learner a's lessons in progress fill page one. A status filter keeps
    // plain course grouping, so the unstarted Getting Started course leads.
    const showNotStarted = async (page) => {
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.locator('#status-filter').selectOption('not-started');
    };

    for (const theme of ['light', 'dark']) {
      const { context, page } = await signIn('a');
      if (theme === 'dark') {
        await page.evaluate(() => localStorage.setItem('plato_theme', 'dark'));
        await page.reload();
        await page.getByRole('button', { name: /^Open lesson / }).first().waitFor();
      }
      assertVisible(await barColors(await outlineBar(page)), `${theme} outline bar`);
      await showNotStarted(page);
      assertVisible(await barColors(courseBar(page)), `${theme} course bar`);
      await context.close();
    }

    // Forced colors drop fills: the track keeps an outline, the fill takes
    // the text color. WebKit has no forced colors mode.
    if (engine === 'webkit') return;
    const { context, page } = await signIn('a', { forcedColors: 'active' });
    const outline = await barColors(await outlineBar(page));
    await showNotStarted(page);
    for (const colors of [await barColors(courseBar(page)), outline]) {
      assert.equal(colors.outline, 'solid');
      assert.equal(colors.fill, colors.text);
      assert.notEqual(colors.fill, colors.track);
    }
    await context.close();
  });
});
