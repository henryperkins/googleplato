import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const engine = process.env.PLATO_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const assets = process.env.PLATO_TEST_CLIENT_DIST || join(root, 'client/dist');
const evidence = process.env.PLATO_TEST_EVIDENCE || join(root, 'output/playwright/learner-recovery');
const password = randomBytes(24).toString('base64url');
let browser, server, directory, base, storageState;
const results = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const composer = page => page.getByRole('textbox', { name: 'Your message', exact: true });
const unsent = page => page.getByRole('region', { name: 'Unsent response' });
const send = page => page.getByRole('button', { name: 'Send', exact: true }).click();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');

async function login(page, owner) {
  await page.getByRole('textbox', { name: 'Email or Username' }).fill(`learner-${owner}@example.test`);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/lessons');
  await page.getByRole('button', { name: /Open lesson Give constructive feedback/ }).waitFor();
}
async function settings(page) {
  await page.getByRole('button', { name: /— Account/ }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Learning goal').waitFor();
}
async function openFeedback(page) {
  await page.getByRole('button', { name: /Open lesson Give constructive feedback/ }).click();
  await composer(page).waitFor();
}
async function logout(page) {
  await page.getByRole('button', { name: /— Account/ }).click();
  await page.getByRole('menuitem', { name: 'Sign Out', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign Out', exact: true }).click();
  await page.waitForURL('**/login');
}
async function lesson(page, id = 'feedback') {
  await page.goto(`${base}/lessons/${id}`);
  await composer(page).waitFor();
  await page.waitForLoadState('networkidle');
  await page.locator('body').ariaSnapshot();
}
async function api(page, path) {
  return page.evaluate(async path => {
    const auth = JSON.parse(localStorage.getItem('plato_auth'));
    const response = await fetch(path, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    if (!response.ok) throw new Error(`Fixture read failed: ${response.status}`);
    return response.json();
  }, path);
}
async function submission(page, owner = 'a', id = 'feedback') {
  return page.evaluate(({ owner, id }) => JSON.parse(sessionStorage.getItem(`plato_lesson_submission:${owner}:${id}`)), { owner, id });
}
async function waitForSavedSubmission(page, owner = 'a', id = 'feedback') {
  await page.waitForFunction(({ owner, id }) => JSON.parse(sessionStorage.getItem(`plato_lesson_submission:${owner}:${id}`)) === null, { owner, id });
}
async function failCoach(page, hold = false) {
  const reached = deferred(), released = deferred();
  let calls = 0;
  const handler = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    calls++;
    reached.resolve();
    if (hold) await released.promise;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"ai_unavailable","error":"Controlled provider failure"}' }).catch(() => {});
  };
  await page.route('**/v1/ai/coach/*', handler);
  return { reached: reached.promise, release: released.resolve, calls: () => calls, stop: () => page.unroute('**/v1/ai/coach/*', handler) };
}
async function addAttachments(page, image, link) {
  if (image) {
    await page.locator('input[type=file]').setInputFiles({ name: 'response.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: 'Remove response.png', exact: true }).waitFor();
  }
  if (link) {
    await page.getByRole('button', { name: 'Attach a link', exact: true }).click();
    await page.getByRole('textbox', { name: 'Link URL', exact: true }).fill('https://example.test/reference');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: /Remove link/ }).waitFor();
  }
}
async function withPage(t, run) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === base || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('dialog', dialog => dialog.accept());
  const errors = [];
  const pendingRequests = new Set();
  const recentRequests = [];
  page.on('request', request => { pendingRequests.add(request.url()); recentRequests.push(request.method() + ' ' + request.url()); });
  page.on('requestfinished', request => pendingRequests.delete(request.url()));
  page.on('requestfailed', request => pendingRequests.delete(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  try {
    await run(page);
    assert.deepEqual(errors, [], 'no unhandled browser errors');
    results.push({ name: t.name, status: 'pass' });
  } catch (error) {
    results.push({ name: t.name, status: 'fail', error: error.message, errors, pendingRequests: [...pendingRequests], recentRequests: recentRequests.slice(-30) });
    await writeFile(join(evidence, `${engine}-${t.name.replace(/\W+/g, '-').slice(0,90)}-failure.txt`), await page.locator('body').ariaSnapshot());
    await page.screenshot({ path: join(evidence, `${engine}-${t.name.replace(/\W+/g, '-').slice(0,90)}-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

describe(`Learner recovery and responsive layout (${engine})`, { timeout: 180000 }, () => {
  before(async () => {
    assert.ok(existsSync(join(assets, 'index.html')), 'Build the client before browser tests');
    await mkdir(evidence, { recursive: true });
    directory = await mkdtemp(join(tmpdir(), 'plato-learner-'));
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
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/login`);
    await login(page, 'a');
    storageState = await context.storageState();
    await context.close();
  });
  after(async () => {
    await writeFile(join(evidence, `${engine}-checks.json`), JSON.stringify({ engine, version: browser?.version(), substitutions: ['isolated SQLite fixture', 'deterministic AI/link responses', 'scenario failure/response interception'], checks: results }, null, 2));
    await browser?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 3000); timer.unref();
      try { await exited; } finally { clearTimeout(timer); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('keeps sign-in guidance and password recovery readable with enlarged text', t => withPage(t, async page => {
    await page.context().clearCookies();
    await page.addInitScript(() => localStorage.removeItem('plato_auth'));
    const geometry = [];
    for (const theme of ['light', 'dark']) {
      for (const [width, height, scale] of [[320,760,1], [320,760,2], [390,844,2], [430,932,2], [844,390,1], [1440,900,1]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`${base}/login`);
        await page.getByRole('textbox', { name: 'Email or Username', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
        await page.evaluate(({ theme, scale }) => {
          document.documentElement.classList.toggle('dark', theme === 'dark');
          document.documentElement.style.fontSize = `${scale * 100}%`;
        }, { theme, scale });
        await page.evaluate(() => document.fonts.ready);
        for (const state of ['clean', 'invalid']) {
          if (state === 'invalid') {
            await page.getByRole('button', { name: 'Sign in', exact: true }).focus();
            await page.keyboard.press('Enter');
            await page.getByText('Please enter your email or username.', { exact: true }).waitFor();
          }
          const measured = await page.evaluate(() => {
            const card = document.querySelector('[data-slot="card"]').getBoundingClientRect();
            const targets = [...document.querySelectorAll('span, a')].filter(el =>
              ['Continue with Google', 'Sign in', 'or sign in with password', 'Forgot password?'].includes(el.textContent.trim()));
            const texts = targets.map(el => {
              const range = document.createRange(); range.selectNodeContents(el);
              const bounds = [card];
              const button = el.closest('button');
              if (button) bounds.push(button.getBoundingClientRect());
              return { text: el.textContent.trim(), fits: bounds.every(bound => [...range.getClientRects()].every(r =>
                r.left >= bound.left - 1 && r.right <= bound.right + 1 && r.top >= bound.top - 1 && r.bottom <= bound.bottom + 1)) };
            });
            const label = document.querySelector('label[for="login-password"]').getBoundingClientRect();
            const link = document.querySelector('a[href="/forgot-password"]').getBoundingClientRect();
            const overlap = Math.min(label.right, link.right) - Math.max(label.left, link.left) > 1
              && Math.min(label.bottom, link.bottom) - Math.max(label.top, link.top) > 1;
            return { texts, overlap, width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth };
          });
          geometry.push({ theme, width, height, scale, state, ...measured });
          assert.equal(measured.texts.length, 4);
          assert.ok(measured.texts.every(text => text.fits), JSON.stringify(geometry.at(-1)));
          assert.equal(measured.overlap, false, 'Password and recovery link do not overlap');
          assert.ok(measured.scrollWidth <= measured.width + 1);
          if (width === 320 && scale === 2) await page.screenshot({ path: join(evidence, `${engine}-login-${theme}-320-text200-${state}.png`), fullPage: true });
        }
      }
    }
    await writeFile(join(evidence, `${engine}-login-layout.json`), JSON.stringify(geometry, null, 2));
  }));

  it('keeps keyboard focus through link rejection, correction and retry without duplicate requests', t => withPage(t, async page => {
    await lesson(page);
    await page.getByRole('button', { name: 'Attach a link', exact: true }).focus();
    await page.keyboard.press('Enter');
    const input = page.getByRole('textbox', { name: 'Link URL', exact: true });
    await input.fill('not a valid URL');
    const reached = deferred(), released = deferred();
    let requests = 0;
    const handler = async route => {
      requests++;
      reached.resolve();
      await released.promise;
      await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Enter a valid http or https URL."}' }).catch(() => {});
    };
    await page.route('**/v1/links/fetch', handler);
    try {
      await page.keyboard.press('Enter'); await reached.promise;
      assert.ok(await input.evaluate(el => document.activeElement === el), 'pending link keeps URL focus');
      await page.keyboard.insertText('cannot change an in-flight URL');
      assert.equal(await input.inputValue(), 'not a valid URL');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      assert.equal(await input.isVisible(), true, 'pending Escape matches disabled Cancel');
      assert.equal(requests, 1, 'repeated Enter does not start another request');
      released.resolve();
      await page.getByText('Enter a valid http or https URL.', { exact: true }).waitFor();
      await input.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await input.evaluate(el => document.activeElement === el), 'rejected link stays ready for correction');
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      await page.screenshot({ path: join(evidence, `${engine}-link-rejection-focus.png`), fullPage: true });
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText('https://example.test/reference');
      assert.equal(await input.inputValue(), 'https://example.test/reference');
    } finally {
      released.resolve();
      await page.unroute('**/v1/links/fetch', handler);
    }
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Remove link Test reference', exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('textarea.compose-input'));
    assert.equal(await page.getByRole('button', { name: 'Remove link Test reference', exact: true }).count(), 1);
    assert.equal(await input.count(), 0);
  }));

  it('keeps the Add button focused during keyboard link submission', t => withPage(t, async page => {
    await lesson(page);
    await page.getByRole('button', { name: 'Attach a link', exact: true }).focus();
    await page.keyboard.press('Enter');
    const input = page.getByRole('textbox', { name: 'Link URL', exact: true });
    const add = page.getByRole('group', { name: 'Attach a link', exact: true })
      .getByRole('button', { name: /^(Add|Adding…)$/ });
    await input.fill('https://example.test/unavailable');
    await page.keyboard.press('Tab');
    assert.ok(await add.evaluate(el => document.activeElement === el), 'Tab reaches Add');
    const reached = deferred(), released = deferred();
    let requests = 0;
    const handler = async route => {
      requests++;
      reached.resolve();
      await released.promise;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Could not load the reference. Try again."}' }).catch(() => {});
    };
    await page.route('**/v1/links/fetch', handler);
    try {
      await page.keyboard.press('Space'); await reached.promise;
      await page.getByRole('button', { name: 'Adding…', exact: true }).waitFor();
      assert.ok(await add.evaluate(el => document.activeElement === el), 'pending keyboard activation keeps Add focus');
      assert.ok(await add.isDisabled(), 'pending Add is unavailable for another submission');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      assert.equal(requests, 1, 'pending keyboard activation does not start another request');
      await page.screenshot({ path: join(evidence, engine + '-link-add-button-pending.png'), fullPage: true });
      released.resolve();
      await page.getByText('Could not load the reference. Try again.', { exact: true }).waitFor();
      assert.ok(await add.evaluate(el => document.activeElement === el), 'failed fetch preserves Add focus');
      assert.equal(await add.isDisabled(), false, 'Add becomes available after rejection');
      await page.screenshot({ path: join(evidence, engine + '-link-add-button-rejected.png'), fullPage: true });
      await page.keyboard.press('Shift+Tab');
      assert.ok(await input.evaluate(el => document.activeElement === el), 'Shift+Tab returns to URL correction');
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText('https://example.test/reference');
    } finally {
      released.resolve();
      await page.unroute('**/v1/links/fetch', handler);
    }
    await page.keyboard.press('Tab');
    assert.ok(await add.evaluate(el => document.activeElement === el), 'Tab returns to Add for retry');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Remove link Test reference', exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('textarea.compose-input'));
    assert.equal(await page.getByRole('button', { name: 'Remove link Test reference', exact: true }).count(), 1);
    assert.equal(await input.count(), 0);
  }));

  it('preserves deliberately moved focus on link failure and restores the trigger after cancellation', t => withPage(t, async page => {
    await lesson(page);
    await page.getByRole('button', { name: 'Attach a link', exact: true }).focus();
    await page.keyboard.press('Enter');
    const input = page.getByRole('textbox', { name: 'Link URL', exact: true });
    await input.fill('https://example.test/unavailable');
    const reached = deferred(), released = deferred();
    const handler = async route => {
      reached.resolve();
      await released.promise;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Could not load the reference. Try again."}' }).catch(() => {});
    };
    await page.route('**/v1/links/fetch', handler);
    try {
      await page.keyboard.press('Enter'); await reached.promise;
      await composer(page).focus();
      await page.keyboard.insertText('Keep writing while the link loads.');
      released.resolve();
      await page.getByText('Could not load the reference. Try again.', { exact: true }).waitFor();
      await input.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await composer(page).evaluate(el => document.activeElement === el), 'error does not steal deliberately moved focus');
      assert.equal(await composer(page).inputValue(), 'Keep writing while the link loads.');
      assert.equal(await input.inputValue(), 'https://example.test/unavailable');
    } finally {
      released.resolve();
      await page.unroute('**/v1/links/fetch', handler);
    }
    await input.focus(); await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Attach a link');
    assert.equal(await input.count(), 0);
    assert.equal(await composer(page).inputValue(), 'Keep writing while the link loads.');
  }));

  it('shows lesson choices immediately on load, filtering, and pagination with either motion preference', t => withPage(t, async page => {
    async function assertImmediateCards() {
      const cards = await page.locator('ul[aria-label] > li').evaluateAll(items => items.map(item => {
        const style = getComputedStyle(item);
        return { animation: style.animationName, delay: style.animationDelay, opacity: style.opacity, transform: style.transform };
      }));
      assert.ok(cards.length > 0, 'the current lesson list is populated');
      for (const card of cards) {
        assert.deepEqual(card, { animation: 'none', delay: '0s', opacity: '1', transform: 'none' });
      }
    }
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion });
      await page.goto(`${base}/lessons`);
      await page.getByRole('button', { name: /Open lesson Give constructive feedback/ }).waitFor();
      await assertImmediateCards();
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await page.getByText('Page 2 of 2', { exact: true }).waitFor();
      await assertImmediateCards();
      await page.getByLabel('Status', { exact: true }).selectOption('completed');
      await page.getByRole('button', { name: /Open lesson Completed communication practice/ }).waitFor();
      await assertImmediateCards();
    }
  }));

  it('counts only public lessons across status filters and pages while keeping private lessons available', t => withPage(t, async page => {
    let completedIsPrivate = false;
    await page.route('**/v1/lessons', async route => {
      const response = await route.fetch();
      const catalog = await response.json();
      const template = catalog.find(item => item.lessonId === 'feedback');
      const communicationProgram = { id: 'communication-program', name: 'Communication practice', position: 1 };
      const lessons = catalog.map(item => ({
        ...item,
        // Legacy standalone courses now render as units. Put those lessons in
        // a real course to exercise course-level progress in the new hierarchy.
        program: !item.program && item.unit?.id === 'communication' ? communicationProgram : item.program,
        status: item.lessonId === 'long-title' || (completedIsPrivate && item.lessonId === 'completed') ? 'private' : item.status,
      }));
      lessons.push(
        { ...template, program: communicationProgram, lessonId: 'fresh-public', name: 'Unstarted public practice', markdown: '# Unstarted public practice' },
        { ...template, program: { id: 'private-course', name: 'Private practice', position: 2 }, unit: null, lessonId: 'private-only', name: 'Shared private practice', markdown: '# Shared private practice', status: 'private', course: { id: 'private-course', name: 'Private practice' } },
        { ...template, program: null, unit: null, lessonId: 'uncategorized', name: 'Uncategorized practice', markdown: '# Uncategorized practice', course: null },
      );
      await route.fulfill({ json: lessons });
    });
    await page.goto(`${base}/lessons`);
    const progress = page.getByRole('progressbar', { name: /progress: 1 of 14 public lessons completed$/ });
    // Course progress comes from the full catalog on either page, not only
    // the visible cards or the active status filter.
    const nextPage = async () => {
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await page.getByText('Page 2 of 2', { exact: true }).waitFor();
    };
    await nextPage();
    await progress.waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await progress.getAttribute('aria-valuenow'), '7');
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1);
      await page.screenshot({ path: join(evidence, `${engine}-public-course-progress-${width}.png`) });
    }
    await page.getByRole('button', { name: /Open lesson Practice giving thoughtful/ }).waitFor();
    // A status filter drops the In progress group, so the course leads page 1.
    for (const status of ['completed', 'in-progress', 'not-started', 'all']) {
      await page.getByLabel('Status', { exact: true }).selectOption(status);
      if (status === 'all') await nextPage();
      await progress.waitFor();
      assert.equal(await progress.getAttribute('aria-valuenow'), '7');
    }
    await page.getByLabel('Course', { exact: true }).selectOption('private-course');
    await page.getByRole('button', { name: /Open lesson Shared private practice/ }).waitFor();
    assert.equal(await page.getByRole('progressbar').count(), 0, 'Private-only courses have no progress bar');
    await page.getByLabel('Course', { exact: true }).selectOption('none');
    await page.getByRole('button', { name: /Open lesson Uncategorized practice/ }).waitFor();
    assert.equal(await page.getByRole('progressbar').count(), 0, 'Uncategorized lessons need no header');
    completedIsPrivate = true;
    await page.reload();
    await nextPage();
    await page.getByRole('progressbar', { name: /progress: 0 of 13 public lessons completed$/ }).waitFor();
    await page.getByLabel('Status', { exact: true }).selectOption('completed');
    await page.getByRole('button', { name: /Open lesson Completed communication practice/ }).waitFor();
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '0', 'A completed private lesson stays available without increasing progress');
  }));

  it('warns on native draft storage exhaustion and retains exact work after retry and reload', t => withPage(t, async page => {
    await lesson(page);
    await composer(page).fill('Earlier retained draft');
    await page.waitForFunction(() => sessionStorage.getItem('plato_lesson_draft:a:feedback')?.includes('Earlier retained draft'));
    const quota = await page.evaluate(() => {
      let filler = ''; const errors = [];
      for (const size of [1048576, 65536, 4096, 256, 16, 1]) {
        while (filler.length + size <= 25 * 1024 * 1024) {
          try { sessionStorage.setItem('test-quota', filler + 'x'.repeat(size)); filler += 'x'.repeat(size); }
          catch (error) { errors.push(error.name); break; }
        }
      }
      return { chars: filler.length, errors };
    });
    assert.ok(quota.errors.includes('QuotaExceededError'), 'exercise native storage capacity, not a replaced Storage API');
    const latest = '  Latest response 日本語 🌱\nA detailed next step.  '.repeat(8);
    await composer(page).fill(latest);
    await addAttachments(page, true, true);
    const warning = page.getByText('Draft not kept for reload. Keep this tab open.', { exact: true });
    await warning.waitFor();
    assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), true,
      'a memory-only draft activates the existing unload guard');
    await page.getByRole('button', { name: 'Retry keeping draft', exact: true }).click();
    assert.equal(await warning.isVisible(), true, 'an unsuccessful retry must not clear the warning');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.testCopiedDraft = text; },
    } }));
    await page.getByRole('button', { name: 'Copy draft text', exact: true }).click();
    await page.getByText('Draft text copied.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.testCopiedDraft), latest);
    await page.screenshot({ path: join(evidence, `${engine}-draft-quota-warning.png`), fullPage: true });
    await page.getByRole('button', { name: 'Back to lessons' }).click();
    await openFeedback(page);
    await warning.waitFor();
    assert.equal(await composer(page).inputValue(), latest, 'navigation keeps the newest in-memory work');
    await page.evaluate(() => sessionStorage.removeItem('test-quota'));
    await page.getByRole('button', { name: 'Retry keeping draft', exact: true }).focus();
    await page.keyboard.press('Enter');
    const retained = page.getByText('Unsent draft kept in this tab.', { exact: true });
    await retained.waitFor();
    assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false,
      'verified retention removes the unload guard');
    assert.equal(await retained.evaluate(element => element === document.activeElement), true, 'removed retry control leaves focus on its result');
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('plato_lesson_draft:a:feedback')).draft);
    assert.equal(stored.text, latest); assert.equal(stored.images.length, 1); assert.equal(stored.links.length, 1);
    await page.reload(); await composer(page).waitFor();
    assert.equal(await composer(page).inputValue(), latest);
    assert.equal(await page.getByRole('button', { name: 'Remove response.png', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /Remove link/ }).count(), 1);
    const restored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('plato_lesson_draft:a:feedback')).draft);
    assert.deepEqual(restored, stored);
    await page.screenshot({ path: join(evidence, `${engine}-draft-quota-recovered.png`), fullPage: true });
    await writeFile(join(evidence, `${engine}-draft-quota.json`), JSON.stringify({ quota, restored, clipboard: 'writeText substituted to verify exact text; OS clipboard untested' }, null, 2));
  }));

  it('keeps a draft warning until verified readback and handles unavailable copying', t => withPage(t, async page => {
    await lesson(page, 'practice-9');
    await composer(page).fill('Earlier retained draft');
    await page.waitForFunction(() => sessionStorage.getItem('plato_lesson_draft:a:practice-9')?.includes('Earlier retained draft'));
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.restoreDraftStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('plato_lesson_draft:')) return;
        return original.call(this, key, value);
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard unavailable'); } } });
    });
    await composer(page).fill('Keep this text when readback fails');
    const warning = page.getByText('Draft not kept for reload. Keep this tab open.', { exact: true });
    await warning.waitFor();
    await page.getByRole('button', { name: 'Copy draft text', exact: true }).click();
    await page.getByText('Select your draft text to copy it.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry keeping draft', exact: true }).click();
    assert.equal(await warning.isVisible(), true);
    await composer(page).fill('');
    await warning.waitFor();
    await page.evaluate(() => window.restoreDraftStorage());
    await page.getByRole('button', { name: 'Retry keeping draft', exact: true }).click();
    await warning.waitFor({ state: 'hidden' });
    await page.reload(); await composer(page).waitFor();
    assert.equal(await composer(page).inputValue(), '', 'a retained clear must not resurrect an earlier draft');
  }));

  for (const lostAcknowledgment of [false, true]) {
    it(`distinguishes coach waiting, pending save and acknowledged progress${lostAcknowledgment ? ' after lost acknowledgment' : ''}`, t => withPage(t, async page => {
      const id = lostAcknowledgment ? 'practice-8' : 'practice-7';
      await lesson(page, id);
      const coachReached = deferred(), coachReleased = deferred(), saveReached = deferred(), saveReleased = deferred();
      let coachCalls = 0, saveCalls = 0;
      await page.route(`**/v1/ai/coach/${id}`, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        coachCalls++; coachReached.resolve(); await coachReleased.promise; await route.continue().catch(() => {});
      });
      await page.route(`**/v1/sync/lesson-turn/${id}`, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        saveCalls++; saveReached.resolve(); await saveReleased.promise;
        if (lostAcknowledgment && saveCalls === 1) { await route.fetch(); return route.abort('failed'); }
        return route.continue().catch(() => {});
      });
      try {
        const text = `Response with held save ${id}`;
        await composer(page).fill(text); await send(page); await coachReached.promise;
        await page.getByText('Waiting for the coach…', { exact: true }).waitFor();
        assert.equal(await page.getByText('Progress saved.', { exact: true }).count(), 0);
        coachReleased.resolve(); await saveReached.promise;
        await page.getByText('Saving progress…', { exact: true }).waitFor();
        await page.getByText('Your reply is saved in this tab.', { exact: true }).waitFor({ state: 'hidden' });
        const first = await submission(page, 'a', id);
        const pending = await api(page, `/v1/sync/lesson-turn/${id}`);
        assert.equal(pending.messages.data.some(message => message.id === `${first.id}:0`), false);
        await composer(page).fill('Newer unsent draft during saving');
        await composer(page).press('Control+Enter');
        await page.getByText('Wait for progress to finish saving, then send.', { exact: true }).waitFor();
        assert.equal(await unsent(page).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), false);
        await page.screenshot({ path: join(evidence, `${engine}-${id}-pending-progress.png`), fullPage: true });
        saveReleased.resolve();
        if (lostAcknowledgment) {
          await page.getByText('Progress not confirmed saved.', { exact: true }).waitFor();
          const committed = await api(page, `/v1/sync/lesson-turn/${id}`);
          assert.equal(committed.messages.data.filter(message => message.id === `${first.id}:0`).length, 1);
          const retryReached = deferred(), retryReleased = deferred();
          await page.unroute(`**/v1/sync/lesson-turn/${id}`);
          await page.route(`**/v1/sync/lesson-turn/${id}`, async route => {
            if (route.request().method() !== 'POST') return route.continue();
            saveCalls++; retryReached.resolve(); await retryReleased.promise; await route.continue().catch(() => {});
          });
          try {
            await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
            await retryReached.promise;
            await page.getByText('Saving progress…', { exact: true }).waitFor();
          } finally { retryReleased.resolve(); }
        }
        await page.getByText('Progress saved.', { exact: true }).waitFor();
        await waitForSavedSubmission(page, 'a', id);
        const saved = await api(page, `/v1/sync/lesson-turn/${id}`);
        assert.equal(saved.messages.data.filter(message => message.id === `${first.id}:0`).length, 1);
        assert.equal(coachCalls, 1); assert.equal(saveCalls, lostAcknowledgment ? 2 : 1);
        assert.equal(await composer(page).inputValue(), 'Newer unsent draft during saving');
        assert.doesNotMatch(JSON.stringify(saved), /Progress saved|Saving progress/);
        await page.reload(); await composer(page).waitFor();
        await page.getByText('Progress saved.', { exact: true }).waitFor();
        assert.ok((await page.getByRole('log').innerText()).includes(text));
        assert.equal(await composer(page).inputValue(), 'Newer unsent draft during saving');
        await page.screenshot({ path: join(evidence, `${engine}-${id}-saved-progress.png`), fullPage: true });
        await writeFile(join(evidence, `${engine}-${id}-save-counts.json`), JSON.stringify({ coachCalls, saveCalls, turnId: first.id, committedMessages: saved.messages.data.filter(message => message.id.startsWith(first.id)), newerDraft: await composer(page).inputValue() }, null, 2));
      } finally { coachReleased.resolve(); saveReleased.resolve(); }
    }));
  }

  for (const failure of ['network failure', 'incomplete acknowledgment']) {
    it(`keeps a failed save retry recoverable after ${failure}`, t => withPage(t, async page => {
      const id = failure === 'network failure' ? 'practice-9' : 'practice-10';
      await lesson(page, id);
      let coachCalls = 0;
      const attempts = [];
      await page.route(`**/v1/ai/coach/${id}`, async route => {
        if (route.request().method() === 'POST') coachCalls++;
        return route.continue();
      });
      await page.route(`**/v1/sync/lesson-turn/${id}`, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        attempts.push(route.request().postDataJSON());
        if (attempts.length === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        if (attempts.length === 2) {
          if (failure === 'network failure') return route.abort('failed');
          const state = await (await route.fetch()).json();
          delete state.lessonKB;
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) });
        }
        return route.continue();
      });

      const text = `Preserve my response after ${failure}.`;
      await composer(page).fill(text); await send(page);
      const retry = page.getByRole('button', { name: 'Retry saving', exact: true });
      await retry.waitFor();
      await composer(page).fill('Keep this newer draft too.');
      await retry.click();
      await page.getByText('Progress not confirmed saved.', { exact: true }).waitFor();
      assert.equal(attempts.length, 2);
      assert.equal(await retry.isEnabled(), true, 'a failed retry remains available');
      assert.equal(await page.getByText('Saving progress…', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Progress saved.', { exact: true }).count(), 0);
      assert.ok((await page.getByRole('log').innerText()).includes(text));
      if (failure === 'incomplete acknowledgment') {
        await page.getByText('The save could not be confirmed. Your reply is retained; retry saving.', { exact: true }).waitFor();
      }

      await retry.click();
      await page.getByText('Progress saved.', { exact: true }).waitFor();
      assert.equal(coachCalls, 1, 'save retries never regenerate the coach reply');
      assert.equal(attempts.length, 3);
      assert.ok(attempts.every(attempt => attempt.turnId === attempts[0].turnId));
      const saved = await api(page, `/v1/sync/lesson-turn/${id}`);
      assert.equal(saved.messages.data.filter(message => message.id === `${attempts[0].turnId}:0`).length, 1);
      await page.reload(); await composer(page).waitFor();
      await page.getByText('Progress saved.', { exact: true }).waitFor();
      assert.ok((await page.getByRole('log').innerText()).includes(text));
      assert.equal(await composer(page).inputValue(), 'Keep this newer draft too.');
    }));
  }

  for (const retryFails of [false, true]) {
    it(`reopening during a save retry joins its ${retryFails ? 'failure' : 'success'}`, t => withPage(t, async page => {
      await lesson(page);
      const retryReached = deferred(), retryReleased = deferred();
      let coachCalls = 0;
      const attempts = [];
      await page.route('**/v1/ai/coach/feedback', async route => {
        if (route.request().method() === 'POST') coachCalls++;
        return route.continue();
      });
      await page.route('**/v1/sync/lesson-turn/feedback', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        attempts.push(route.request().postDataJSON());
        if (attempts.length === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        if (attempts.length === 2) {
          retryReached.resolve(); await retryReleased.promise;
          if (retryFails) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }).catch(() => {});
        }
        return route.continue().catch(() => {});
      });
      try {
        const text = `Keep the reply when reopening a ${retryFails ? 'failed' : 'successful'} save retry.`;
        await composer(page).fill(text); await send(page);
        await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor();
        await composer(page).fill('Newer unsent work while retrying.');
        await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
        await retryReached.promise;
        await page.getByRole('button', { name: 'Back to lessons' }).click();
        await page.getByRole('button', { name: /Open lesson Give constructive feedback/ }).click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.getByText('Loading your saved conversation…', { exact: true }).isVisible(), true,
          'the reopened view joins the held retry instead of publishing an obsolete failure');
        retryReleased.resolve();
        if (retryFails) {
          await page.getByText('Progress not confirmed saved.', { exact: true }).waitFor();
          await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
        }
        await page.getByText('Progress saved.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
        assert.equal(await composer(page).inputValue(), 'Newer unsent work while retrying.');
        assert.ok((await page.getByRole('log').innerText()).includes(text));
        assert.equal(coachCalls, 1);
        assert.equal(attempts.length, retryFails ? 3 : 2);
        assert.ok(attempts.every(attempt => attempt.turnId === attempts[0].turnId));
        const saved = await api(page, '/v1/sync/lesson-turn/feedback');
        assert.equal(saved.messages.data.filter(message => message.id === `${attempts[0].turnId}:0`).length, 1);
      } finally { retryReleased.resolve(); }
    }));
  }

  for (const reducedMotion of ['no-preference', 'reduce']) {
    it(`saved reply confirmation fades before the coach with ${reducedMotion} motion`, t => withPage(t, async page => {
      await page.emulateMedia({ reducedMotion });
      if (reducedMotion === 'no-preference') await page.setViewportSize({ width: 1280, height: 900 });
      await lesson(page, 'practice-12');
      const assistantCount = await page.locator('[data-chat-message="assistant"]').count();
      const saved = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/v1/sync/lesson-turn/practice-12');
      await composer(page).fill('The report needs a clearer next step.');
      await send(page);
      const notice = page.getByText('Your reply is saved in this tab.', { exact: true });
      await notice.waitFor({ timeout: 1000 });
      assert.equal(await notice.getAttribute('role'), 'status');
      assert.equal(await page.locator('[data-chat-message]').filter({ hasText: 'Your reply is saved' }).count(), 0);
      assert.equal((await saved).status(), 200, 'generation and saving continue during the confirmation');
      assert.equal(await notice.isVisible(), true);
      assert.equal(await page.locator('[data-chat-message="assistant"]').count(), assistantCount, 'even a fast reply waits for the confirmation to fade');
      const animation = await notice.evaluate(element => {
        const effect = element.getAnimations()[0]?.effect;
        return effect ? { duration: effect.getTiming().duration, frames: effect.getKeyframes() } : null;
      });
      assert.ok(animation && animation.duration <= 2000, 'the acknowledgment has a short animation');
      assert.equal(animation.frames.at(-1).opacity, '0', 'the animation fades out');
      assert.equal(animation.frames.some(frame => frame.transform && frame.transform !== 'none'), reducedMotion === 'no-preference', 'reduced motion removes the scale pulse');
      await page.screenshot({ path: join(evidence, `${engine}-saved-reply-${reducedMotion}.png`), fullPage: true });
      await notice.waitFor({ state: 'hidden', timeout: 2500 });
      await page.waitForFunction(count => document.querySelectorAll('[data-chat-message="assistant"]').length === count + 1, assistantCount);
      const state = await api(page, '/v1/sync/lesson-turn/practice-12');
      assert.doesNotMatch(JSON.stringify(state), /Your reply is saved/);
      assert.equal(await page.getByText('Your reply is saved.', { exact: true }).count(), 0, 'a normal save does not repeat the acknowledgment');
      await page.screenshot({ path: join(evidence, `${engine}-saved-reply-${reducedMotion}-dismissed.png`), fullPage: true });
    }));
  }

  it('clears the previous save confirmation before the next coach request', t => withPage(t, async page => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await lesson(page, 'practice-13');
    const failSave = route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue();
    await page.route('**/v1/sync/lesson-turn/practice-13', failSave);
    await composer(page).fill('Please include a concrete deadline.');
    await send(page);
    await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor();
    await page.unroute('**/v1/sync/lesson-turn/practice-13', failSave);
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    const notice = page.getByText('Your reply is saved.', { exact: true });
    await notice.waitFor();
    const reached = deferred(), released = deferred();
    let coachRequest;
    await page.route('**/v1/ai/coach/*', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      coachRequest = route.request().postDataJSON();
      reached.resolve();
      await released.promise;
      await route.continue().catch(() => {});
    });
    try {
      await composer(page).fill('Could you send the revision by Friday?');
      await send(page);
      await reached.promise;
      assert.equal(await notice.count(), 0, 'the previous save must not appear to confirm the new reply');
      assert.equal(coachRequest.submission.text, 'Could you send the revision by Friday?');
      assert.doesNotMatch(JSON.stringify(coachRequest), /Your reply is saved/);
      const localNotice = page.getByText('Your reply is saved in this tab.', { exact: true });
      await localNotice.waitFor();
      await localNotice.waitFor({ state: 'hidden', timeout: 2500 });
      await page.getByText('Thinking...', { exact: true }).waitFor();
    } finally { released.resolve(); }
    await waitForSavedSubmission(page, 'a', 'practice-13');
    assert.equal(await notice.count(), 0);
  }));

  it('keeps save failures and reassessment notices visible', t => withPage(t, async page => {
    for (const reviewRequired of [false, true]) {
      const id = reviewRequired ? 'practice-11' : 'practice-10';
      await lesson(page, id);
      await page.route(`**/v1/sync/lesson-turn/${id}`, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        if (!reviewRequired) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        const response = await route.fetch();
        const state = await response.json();
        state.lessonKB.data.assessmentReviewRequired = true;
        await route.fulfill({ response, json: state });
      });
      await composer(page).fill('The deadline makes the request actionable.');
      await send(page);
      const notice = page.getByText(reviewRequired ? /The lesson requirements changed/ : /Your reply has not been confirmed saved/);
      await notice.waitFor();
      await delay(2000);
      assert.equal(await notice.isVisible(), true);
      if (!reviewRequired) {
        assert.equal(await page.getByRole('button', { name: 'Retry saving', exact: true }).isEnabled(), true);
        await page.unroute(`**/v1/sync/lesson-turn/${id}`);
        await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
        const saved = page.getByText('Your reply is saved.', { exact: true });
        await saved.waitFor();
        await saved.waitFor({ state: 'hidden', timeout: 2500 });
      }
    }
  }));

  it('retains a failed response and newer draft through navigation and reload', t => withPage(t, async page => {
    await lesson(page);
    const failure = await failCoach(page, true);
    await composer(page).fill('  Original response 日本語 🌱\nSecond line  ');
    await send(page); await failure.reached;
    assert.equal(await composer(page).evaluate(input => document.activeElement === input && !input.disabled && !input.readOnly), true);
    await composer(page).fill('Newer writing that must remain');
    await page.getByRole('button', { name: 'Back to lessons' }).click();
    failure.release();
    await page.getByRole('button', { name: /Open lesson Give constructive feedback/ }).click();
    await unsent(page).waitFor();
    assert.equal(await composer(page).inputValue(), 'Newer writing that must remain');
    const first = await submission(page);
    assert.equal(first.draft.text, '  Original response 日本語 🌱\nSecond line  ');
    await page.reload(); await unsent(page).waitFor();
    assert.equal(await composer(page).inputValue(), 'Newer writing that must remain');
    assert.equal((await submission(page)).id, first.id);
    await page.screenshot({ path: join(evidence, `${engine}-retained-and-newer-draft.png`), fullPage: true });
    await failure.stop();
    await page.getByRole('button', { name: 'Retry response', exact: true }).click();
    await waitForSavedSubmission(page);
    const state = await api(page, '/v1/sync/lesson-turn/feedback');
    assert.equal(state.messages.data.filter(m => m.id === `${first.id}:0`).length, 1);
    assert.equal(await composer(page).inputValue(), 'Newer writing that must remain');
    assert.equal(await submission(page), null);
  }));

  it('reopening a pending request joins its late success without generating twice', t => withPage(t, async page => {
    await lesson(page);
    const reached = deferred(), released = deferred(); let calls = 0;
    await page.route('**/v1/ai/coach/*', async route => { if (route.request().method() !== 'POST') return route.continue(); calls++; reached.resolve(); await released.promise; await route.continue(); });
    await composer(page).fill('Late successful response'); await send(page); await reached.promise;
    const first = await submission(page);
    await composer(page).fill('Next response in progress');
    await page.getByRole('button', { name: 'Back to lessons' }).click();
    await page.getByRole('button', { name: /Open lesson Give constructive feedback/ }).click();
    released.resolve();
    await composer(page).waitFor(); await page.waitForLoadState('networkidle');
    assert.equal(calls, 1);
    assert.equal(await composer(page).inputValue(), 'Next response in progress');
    assert.equal(await submission(page), null);
    const state = await api(page, '/v1/sync/lesson-turn/feedback');
    assert.equal(state.messages.data.filter(m => m.id === `${first.id}:0`).length, 1);
    assert.ok((await page.getByRole('log').innerText()).includes('Late successful response'));
  }));

  it('provider failure while staying in the lesson preserves newer text and attachments', t => withPage(t, async page => {
    await lesson(page);
    const failure = await failCoach(page, true);
    await composer(page).fill('Earlier response awaiting the coach'); await send(page); await failure.reached;
    const first = await submission(page);
    await composer(page).fill('Newer response with separate attachments'); await addAttachments(page, true, true);
    failure.release(); await unsent(page).waitFor();
    assert.equal(await composer(page).inputValue(), 'Newer response with separate attachments');
    assert.equal(await page.getByRole('button', { name: 'Remove response.png', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /Remove link/ }).count(), 1);
    assert.equal((await submission(page)).draft.text, 'Earlier response awaiting the coach');
    await failure.stop();
    await page.getByRole('button', { name: 'Retry response', exact: true }).click();
    await waitForSavedSubmission(page);
    assert.equal(await composer(page).inputValue(), 'Newer response with separate attachments');
    assert.equal(await page.getByRole('button', { name: 'Remove response.png', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /Remove link/ }).count(), 1);
    const saved = (await api(page, '/v1/sync/lesson-turn/feedback')).messages.data.filter(message => message.id === `${first.id}:0`);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].metadata, null, 'newer attachments must not be sent with the earlier response');
  }));

  it('reload during generation retains input without automatically repeating inference', t => withPage(t, async page => {
    await lesson(page);
    const failure = await failCoach(page, true);
    await composer(page).fill('Interrupted page response'); await send(page); await failure.reached;
    const first = await submission(page);
    const reload = page.reload(); failure.release(); await reload;
    await unsent(page).waitFor();
    assert.equal((await submission(page)).draft.text, 'Interrupted page response');
    assert.equal((await submission(page)).id, first.id);
    assert.equal(failure.calls(), 1);
  }));

  it('pending submission remains with account A after switching to B and back', t => withPage(t, async page => {
    await lesson(page);
    const failure = await failCoach(page, true);
    await composer(page).fill('Private response for learner A'); await send(page); await failure.reached;
    await logout(page); await login(page, 'b');
    failure.release();
    await openFeedback(page);
    assert.equal(await unsent(page).count(), 0);
    assert.equal(await composer(page).inputValue(), '');
    assert.ok(!(await page.getByRole('log').innerText()).includes('Private response'));
    await logout(page); await login(page, 'a'); await openFeedback(page);
    await unsent(page).waitFor();
    assert.equal((await submission(page)).draft.text, 'Private response for learner A');
  }));

  it('text and optional attachments survive failure, reload and lost acknowledgement', t => withPage(t, async page => {
    for (const [index, image, link] of [[0, false, false], [1, true, false], [2, false, true], [3, true, true]]) {
      const id = `practice-${index + 4}`;
      await lesson(page, id);
      const failure = await failCoach(page);
      if (index === 0) await composer(page).fill('Text control');
      await addAttachments(page, image, link);
      await send(page); await unsent(page).waitFor();
      const original = await submission(page, 'a', id);
      assert.equal(original.draft.images.length, Number(image));
      assert.equal(original.draft.links.length, Number(link));
      await page.reload(); await unsent(page).waitFor();
      assert.deepEqual((await submission(page, 'a', id)).draft, original.draft);
      await failure.stop();
      let posts = 0, inference = 0;
      page.on('request', count);
      function count(request) { if (request.method() === 'POST' && request.url().includes('/v1/ai/coach/')) inference++; }
      await page.route(`**/v1/sync/lesson-turn/${id}`, async route => {
        if (route.request().method() === 'POST' && posts++ === 0) {
          assert.equal((await route.fetch()).status(), 200); await route.abort('failed');
        } else await route.continue();
      });
      await page.getByRole('button', { name: 'Retry response', exact: true }).click();
      await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor();
      await page.reload(); await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
      await page.getByText('Your reply is saved.', { exact: true }).waitFor();
      const saved = (await api(page, `/v1/sync/lesson-turn/${id}`)).messages.data.filter(m => m.id === `${original.id}:0`);
      assert.equal(saved.length, 1); assert.equal(posts, 2); assert.equal(inference, 1);
      assert.equal(saved[0].metadata?.imageKeys?.length || 0, Number(image));
      assert.equal(saved[0].metadata?.links?.length || 0, Number(link));
      for (const key of saved[0].metadata?.imageKeys || []) assert.ok((await api(page, `/v1/sync/${encodeURIComponent(`screenshot:${key}`)}`)).data.startsWith('data:image/'));
      page.off('request', count);
    }
    await page.screenshot({ path: join(evidence, `${engine}-attachments-recovered.png`), fullPage: true });
  }));

  it('failed local retention refuses Send without clearing the only draft copy', t => withPage(t, async page => {
    await page.addInitScript(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('plato_lesson_submission:')) throw new Error('Synthetic quota'); return write.call(this, key, value); };
    });
    await lesson(page);
    let calls = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/v1/ai/coach/')) calls++; });
    await composer(page).fill('Only copy must remain'); await addAttachments(page, true, true); await send(page);
    await page.getByText(/could not be kept for recovery/).waitFor();
    assert.equal(await page.getByText('Your reply is saved in this tab.', { exact: true }).count(), 0);
    assert.equal(await composer(page).inputValue(), 'Only copy must remain');
    assert.equal(await page.getByRole('button', { name: 'Remove response.png', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /Remove link/ }).count(), 1);
    assert.equal(calls, 0);
  }));

  it('reload reconciles a committed turn when the generated journal could not be stored', t => withPage(t, async page => {
    await page.addInitScript(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('plato_generated_turn:')) return; return write.call(this, key, value); };
    });
    await lesson(page, 'practice-8');
    let calls = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/v1/ai/coach/')) calls++; });
    await page.route('**/v1/sync/lesson-turn/practice-8', async route => {
      if (route.request().method() === 'POST') { assert.equal((await route.fetch()).status(), 200); await route.abort('failed'); }
      else await route.continue();
    });
    await composer(page).fill('Committed response with unavailable generated journal'); await send(page);
    await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor();
    await page.getByText(/A recovery copy could not be stored/).waitFor();
    const original = await submission(page, 'a', 'practice-8');
    assert.equal(original.draft.text, 'Committed response with unavailable generated journal');
    await page.reload(); await composer(page).waitFor();
    assert.equal(await submission(page, 'a', 'practice-8'), null);
    assert.equal(await unsent(page).count(), 0);
    assert.equal(calls, 1);
    const state = await api(page, '/v1/sync/lesson-turn/practice-8');
    assert.equal(state.messages.data.filter(m => m.id === `${original.id}:0`).length, 1);
  }));

  it('restore and confirmed discard preserve attachments and newer drafts', t => withPage(t, async page => {
    await lesson(page);
    await failCoach(page);
    await composer(page).fill('Restore exact response'); await addAttachments(page, true, true); await send(page); await unsent(page).waitFor();
    await page.getByRole('button', { name: 'Move to draft', exact: true }).click();
    assert.equal(await composer(page).inputValue(), 'Restore exact response');
    assert.equal(await page.getByRole('button', { name: 'Remove response.png', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /Remove link/ }).count(), 1);
    await send(page); await unsent(page).waitFor(); await composer(page).fill('Keep newer draft');
    assert.equal(await page.getByRole('button', { name: 'Move to draft', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Discard response', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await unsent(page).count(), 1);
    await page.getByRole('button', { name: 'Discard response', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard response', exact: true }).click();
    assert.equal(await composer(page).inputValue(), 'Keep newer draft');
    assert.equal(await submission(page), null);
  }));

  it('Settings fields and feedback stay with their owner through A B A and reload', t => withPage(t, async page => {
    await page.goto(`${base}/settings`); await page.getByLabel('Learning goal').fill('A private goal 🌱');
    await page.getByLabel('Phone', { exact: true }).fill('+1 (555) 010-1234');
    await page.getByLabel('Team', { exact: true }).selectOption('Learning team');
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    await page.getByRole('textbox', { name: 'Profile feedback', exact: true }).fill('A private feedback draft');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await logout(page); await login(page, 'b'); await settings(page);
    await page.getByLabel('Learning goal').waitFor();
    assert.equal(await page.getByLabel('Learning goal').inputValue(), '');
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Profile feedback', exact: true }).inputValue(), '');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual((await api(page, '/v1/me/fields')).values, {});
    await page.screenshot({ path: join(evidence, `${engine}-account-b-settings.png`), fullPage: true });
    await logout(page); await login(page, 'a'); await settings(page); await page.waitForLoadState('networkidle'); await page.reload();
    await page.getByLabel('Learning goal').waitFor();
    assert.equal(await page.getByLabel('Learning goal').inputValue(), 'A private goal 🌱');
    assert.equal(await page.getByLabel('Phone', { exact: true }).inputValue(), '+1 (555) 010-1234');
    assert.equal(await page.getByLabel('Team', { exact: true }).inputValue(), 'Learning team');
    await page.locator('form').filter({ has: page.getByLabel('Learning goal') }).getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#fields-feedback').getByText('Saved!', { exact: true }).waitFor();
    assert.equal((await api(page, '/v1/me/fields')).values.goal, 'A private goal 🌱');
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Profile feedback', exact: true }).inputValue(), 'A private feedback draft');
  }));

  it('saves notes independently of unchanged or malformed optional profile rewrites', t => withPage(t, async page => {
    await page.goto(`${base}/settings`);
    let result = { changed: false };
    const writes = [];
    page.on('request', request => {
      if (request.method() === 'PUT' && /\/v1\/sync\/profile(?:Summary)?$/.test(request.url())) {
        writes.push({ url: request.url(), data: request.postDataJSON()?.data });
      }
    });
    await page.route('**/v1/ai/messages', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }) }));
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Profile feedback', exact: true });
    await input.fill('My profile already describes my preferences.');
    await page.getByRole('button', { name: 'Update profile', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add Profile Feedback' }).waitFor({ state: 'hidden', timeout: 3000 });
    await page.getByRole('status').filter({ hasText: 'Your note is saved.' }).waitFor();
    await page.getByRole('list', { name: 'Your notes' }).getByText('My profile already describes my preferences.', { exact: true }).waitFor();
    assert.equal(writes.length, 1, 'the note has one durable write; unchanged profile data is not rewritten again');
    assert.match(writes[0].url, /\/v1\/sync\/profile$/);
    assert.ok(writes[0].data.learnerNotes.some(note => note.text === 'My profile already describes my preferences.'));
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    assert.equal(await input.inputValue(), '');
    result = {};
    await input.fill('Retain this feedback if the response is malformed.');
    await page.getByRole('button', { name: 'Update profile', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add Profile Feedback' }).waitFor({ state: 'hidden', timeout: 3000 });
    await page.getByRole('status').filter({ hasText: 'Your note is saved. The optional profile rewrite was unavailable; your note will be included in future updates.' }).waitFor();
    await page.getByRole('list', { name: 'Your notes' }).getByText('Retain this feedback if the response is malformed.', { exact: true }).waitFor();
    assert.equal(writes.length, 2, 'the malformed optional rewrite adds no second profile mutation');
    assert.match(writes[1].url, /\/v1\/sync\/profile$/);
    assert.ok(writes[1].data.learnerNotes.some(note => note.text === 'Retain this feedback if the response is malformed.'));
    assert.equal(writes.filter(write => /profileSummary$/.test(write.url)).length, 0);
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    assert.equal(await input.inputValue(), '', 'the independently saved note is not retained as an unsubmitted draft');
  }));

  it('delayed feedback generation cannot save into the next account', t => withPage(t, async page => {
    await page.goto(`${base}/settings`);
    const reached = deferred(), released = deferred();
    await page.route('**/v1/ai/messages', async route => { reached.resolve(); await released.promise; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ profile: { goal: 'Private goal from A' }, summary: 'Private summary A' }) }] }) }); });
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    await page.getByRole('textbox', { name: 'Profile feedback', exact: true }).fill('Private pending feedback A');
    await page.getByRole('button', { name: 'Update profile', exact: true }).click(); await reached.promise;
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await logout(page); await login(page, 'b'); released.resolve();
    await settings(page); await page.waitForLoadState('networkidle');
    assert.equal((await api(page, '/v1/sync/profile')).data.goal, undefined);
    assert.ok(!(await page.locator('body').innerText()).includes('Private summary A'));
    await logout(page); await login(page, 'a'); await settings(page);
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Profile feedback', exact: true }).inputValue(), 'Private pending feedback A');
  }));

  it('lesson titles and metadata fit narrow enlarged text in both themes', t => withPage(t, async page => {
    const geometry = [];
    for (const theme of ['light', 'dark']) {
      await page.goto(`${base}/lessons`); await page.locator('#status-filter').waitFor();
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      for (const [width, height, scale] of [[320,760,1], [390,844,1], [844,390,1], [1440,900,1], [320,760,2]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.evaluate(() => {
          const width = document.documentElement.clientWidth;
          const titles = [...document.querySelectorAll('button[aria-label^="Open lesson"]')].map(button => {
            const title = button.querySelector('span');
            const range = document.createRange(); range.selectNodeContents(title);
            const box = title.getBoundingClientRect();
            return { title: title.textContent.trim(), fits: [...range.getClientRects()].every(r => r.left >= box.left - 1 && r.right <= box.right + 1), width: box.width };
          });
          return { width, scrollWidth: document.documentElement.scrollWidth, titles,
            filters: [...document.querySelectorAll('select')].map(select => ({ id: select.id, left: select.getBoundingClientRect().left, right: select.getBoundingClientRect().right })) };
        });
        geometry.push({ theme, width, height, scale, ...measured });
        assert.ok(measured.scrollWidth <= width + 1, JSON.stringify(measured));
        assert.ok(measured.titles.every(title => title.fits && title.width > (scale === 2 ? 160 : 80)), JSON.stringify(measured.titles));
        assert.ok(measured.filters.every(filter => filter.left >= 0 && filter.right <= width + 1));
        if (scale === 2 || width === 1440) await page.screenshot({ path: join(evidence, `${engine}-lessons-${theme}-${width}-scale${scale}.png`), fullPage: true });
      }
    }
    await writeFile(join(evidence, `${engine}-layout.json`), JSON.stringify(geometry, null, 2));
  }));
});
