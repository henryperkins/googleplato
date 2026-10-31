import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const browserName = process.env.PLATO_TEST_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
assert.ok(browserType, `Unsupported PLATO_TEST_BROWSER: ${browserName}`);
const publishingEvidence = join(root, 'output/playwright/lesson-publishing', browserName === 'chromium' ? '' : browserName);
const mobileEvidence = join(root, 'output/playwright/lesson-mobile-refinement', browserName === 'chromium' ? '' : browserName);
const workspaceEvidence = join(root, 'output/playwright/lesson-workspace', browserName);
const markdown = '# Reviewed Lesson\n\n## Exemplar\nWrite a clear summary.\n\n## Learning Objectives\n- Can identify the main idea.\n- Can write a concise summary.';
let browser;
let server;
let directory;
let base;
let storageState;

async function fixture({ draft = true, width = 1280, height = 900, theme = 'light', readiness = 8, lesson = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, storageState });
  await context.addInitScript(value => localStorage.setItem('plato_theme', value), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const state = {
    lesson: {
      lessonId: 'publishing', name: draft ? 'Untitled draft' : 'Reviewed Lesson', status: draft ? 'draft' : 'private',
      markdown: draft ? '' : markdown, version: 1, sharedWith: ['learner'],
      conversation: [{ role: 'assistant', content: 'The lesson is ready for review.' }],
      readiness, conversationRevision: 'revision-1', markdownRevision: draft ? null : 'revision-1',
      ...lesson,
    },
    writes: [], aiCalls: 0, beforeWrite: null, beforeAI: null, previewMarkdown: markdown,
  };
  await context.route('**/v1/ai/messages', async route => {
    state.aiCalls++;
    if (state.beforeAI && await state.beforeAI(route)) return;
    const text = route.request().postDataJSON().stream
      ? 'I will include that change. Refresh the preview to review it. [READINESS: 8]'
      : state.previewMarkdown;
    await route.fulfill({ json: { content: [{ type: 'text', text }] } });
  });
  await context.route('**/v1/admin/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/admin/lessons/publishing') {
      if (request.method() === 'GET') return route.fulfill({ json: state.lesson });
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        state.writes.push(body);
        if (state.beforeWrite && await state.beforeWrite(route, body)) return;
        state.lesson = { ...state.lesson, ...body, version: state.lesson.version + 1, authoringOperationId: body.operationId };
        return route.fulfill({ json: { ok: true, version: state.lesson.version } });
      }
    }
    if (path === '/v1/admin/lessons') return route.fulfill({ json: [state.lesson] });
    if (path === '/v1/admin/courses') return route.fulfill({ json: [] });
    if (path === '/v1/admin/stats/lessons') return route.fulfill({ json: { byLesson: {} } });
    if (path === '/v1/admin/users') return route.fulfill({ json: [
      { userId: 'learner', name: 'Avery Learner', email: 'avery@example.test', role: 'user' },
    ] });
    return route.fallback();
  });
  await page.goto(`${base}/plato/lessons/publishing/edit`);
  await page.getByRole('heading', { name: draft ? 'New Lesson' : 'Edit Lesson', exact: true }).waitFor();
  return { context, page, state };
}

async function review(page) {
  const previewTab = page.getByRole('tab', { name: 'Preview', exact: true });
  if (await previewTab.isVisible()) await previewTab.click();
  await page.getByRole('button', { name: /^(Generate preview|Refresh preview)$/ }).click();
  await page.waitForFunction(() => document.querySelector('.markdown-preview-body')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('complementary', { name: 'Lesson markdown preview' }).getByRole('heading', { name: 'Reviewed Lesson', exact: true }).waitFor();
}

describe('Lesson publishing workflow', { timeout: 90000 }, () => {
  before(async () => {
    await mkdir(publishingEvidence, { recursive: true });
    await mkdir(mobileEvidence, { recursive: true });
    await mkdir(workspaceEvidence, { recursive: true });
    directory = await mkdtemp(join(tmpdir(), 'plato-publishing-'));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    base = `http://127.0.0.1:${port}`;
    const email = 'publishing@plato.test';
    const password = randomBytes(24).toString('base64url');
    server = spawn(process.execPath, ['dev-sqlite.js'], {
      cwd: join(root, 'server'),
      env: { ...process.env, PORT: String(port), SQLITE_PATH: join(directory, 'test.sqlite'), APP_URL: base,
        JWT_SECRET: randomBytes(32).toString('hex'), ADMIN_EMAIL: email, ADMIN_PASSWORD: password, SKIP_EMAIL: 'true' },
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
        if ((await fetch(`${base}/v1/auth/setup-status`, { signal: AbortSignal.timeout(500) })).ok) break;
      } catch { /* Wait for this test's server. */ }
      assert.ok(Date.now() - started < 15000, `Test server did not start: ${output}`);
      await delay(100);
    }
    browser = await browserType.launch();
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
    } finally { await context.close(); }
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

  it('offers private saving and explicit publishing only after preview review', async () => {
    const { context, page, state } = await fixture();
    try {
      assert.equal(await page.getByRole('button', { name: 'Save & make public', exact: true }).count(), 0);
      await review(page);
      assert.equal(await page.getByRole('button', { name: 'Save & make public', exact: true }).isEnabled(), true);
      await page.getByRole('button', { name: 'Save privately', exact: true }).click();
      await page.waitForURL(`${base}/plato/lessons`);
      assert.equal(state.lesson.status, 'private');
      assert.equal(state.writes.at(-1).markdown, markdown);
      assert.equal(state.aiCalls, 1);
    } finally { await context.close(); }
  });

  it('publishes the reviewed preview in one confirmed write without duplicate activation', async () => {
    const { context, page, state } = await fixture();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      await review(page);
      state.beforeWrite = async () => { await gate; return false; };
      const publish = page.getByRole('button', { name: 'Save & make public', exact: true });
      await publish.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Saving…', exact: true }).waitFor();
      await page.keyboard.press('Enter');
      assert.equal(state.writes.length, 1);
      assert.equal(state.lesson.status, 'draft', 'the server has not confirmed publishing');
      assert.equal(await page.getByText('Lesson is now public.', { exact: true }).count(), 0);
      release();
      await page.waitForURL(`${base}/plato/lessons`);
      await page.getByRole('status').filter({ hasText: 'Lesson is now public.' }).waitFor();
      assert.equal(state.lesson.status, 'public');
      assert.equal(state.writes.length, 1);
      assert.equal(state.writes[0].markdown, markdown);
      assert.equal(state.writes[0].expectedVersion, 1);
      assert.equal(state.aiCalls, 1);
    } finally { release(); await context.close(); }
  });

  for (const committed of [false, true]) {
    it(`recovers the public choice after reload when the lost response ${committed ? 'was committed' : 'was not committed'}`, async () => {
      const { context, page, state } = await fixture({ width: 320 });
      try {
        await review(page);
        state.beforeWrite = async (route, body) => {
          state.beforeWrite = null;
          if (committed) state.lesson = { ...state.lesson, ...body, version: 2, authoringOperationId: body.operationId };
          await route.abort('failed');
          return true;
        };
        await page.getByRole('button', { name: 'Save & make public', exact: true }).click();
        await page.getByRole('button', { name: 'Retry saving lesson', exact: true }).waitFor();
        const original = structuredClone(state.writes[0]);
        page.once('dialog', dialog => dialog.accept());
        await page.reload();
        await page.getByRole('button', { name: 'Retry saving lesson', exact: true }).click();
        await page.waitForURL(`${base}/plato/lessons`);
        assert.equal(state.lesson.status, 'public');
        assert.equal(state.lesson.markdown, markdown);
        assert.equal(state.aiCalls, 1, 'saving and reload must not generate another preview');
        assert.equal(state.writes.length, committed ? 1 : 2);
        if (!committed) assert.deepEqual(state.writes[1], original);
      } finally { await context.close(); }
    });
  }

  it('changes editor visibility without losing shares or the acknowledged save version', async () => {
    const { context, page, state } = await fixture({ draft: false });
    try {
      await page.screenshot({ path: join(publishingEvidence, 'saved-editor-private.png'), fullPage: true });
      await page.getByRole('button', { name: 'Make public', exact: true }).click();
      await page.getByRole('button', { name: /Visibility and sharing.*Public/ }).waitFor();
      await page.screenshot({ path: join(publishingEvidence, 'saved-editor-public.png'), fullPage: true });
      assert.deepEqual(state.lesson.sharedWith, ['learner']);
      assert.equal(state.writes[0].markdown, undefined);
      await page.getByRole('button', { name: /Visibility and sharing.*Public/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Visibility & Sharing' });
      await dialog.getByRole('radio', { name: 'Private', exact: true }).focus();
      await page.keyboard.press('Space');
      assert.equal(await dialog.getByRole('checkbox', { name: 'Share with Avery Learner' }).isChecked(), true);
      await dialog.getByRole('button', { name: 'Share with 1 user', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Save privately', exact: true }).click();
      await page.waitForURL(`${base}/plato/lessons`);
      assert.deepEqual(state.writes.map(write => write.expectedVersion), [1, 2, 3]);
      assert.deepEqual(state.lesson.sharedWith, ['learner']);
      assert.equal(state.aiCalls, 0);
    } finally { await context.close(); }
  });

  it('keeps an unsaved reviewed preview when changing visibility in the editor', async () => {
    const { context, page, state } = await fixture({ draft: false });
    try {
      // Refreshing can produce a new preview even before another conversation turn.
      state.lesson.markdown = markdown.replace('clear summary', 'short summary');
      await page.reload();
      await review(page);
      await page.getByRole('button', { name: /Visibility and sharing.*Private/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Visibility & Sharing' });
      await dialog.getByRole('radio', { name: 'Public', exact: true }).focus();
      await page.keyboard.press('Space');
      await dialog.getByRole('button', { name: 'Make public', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.match(state.lesson.markdown, /short summary/);
      assert.equal(state.writes[0].markdown, undefined);
      await page.getByRole('button', { name: 'Update lesson', exact: true }).click();
      await page.waitForURL(`${base}/plato/lessons`);
      assert.equal(state.lesson.markdown, markdown);
      assert.equal(state.lesson.status, 'public');
      assert.equal(state.aiCalls, 1);
    } finally { await context.close(); }
  });

  it('clears a direct publishing error after the same visibility write is confirmed', async () => {
    const { context, page, state } = await fixture({ draft: false });
    try {
      state.beforeWrite = async route => {
        state.beforeWrite = null;
        await route.abort('failed');
        return true;
      };
      await page.getByRole('button', { name: 'Make public', exact: true }).click();
      await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor();
      assert.equal(state.lesson.status, 'private');
      assert.equal(await page.getByRole('alert').count(), 1);
      await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
      await page.getByRole('button', { name: /Visibility and sharing.*Public/ }).waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.deepEqual(state.writes[1], state.writes[0]);
      assert.equal(state.aiCalls, 0);
    } finally { await context.close(); }
  });

  it('keeps a rejected visibility choice correctable inside the editor dialog', async () => {
    const { context, page, state } = await fixture({ draft: false });
    try {
      await page.getByRole('button', { name: /Visibility and sharing.*Private/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Visibility & Sharing' });
      await dialog.getByRole('radio', { name: 'Public', exact: true }).focus();
      await page.keyboard.press('Space');
      state.beforeWrite = async route => {
        state.beforeWrite = null;
        await route.fulfill({ status: 400, json: { error: 'Review the lesson objectives before publishing.' } });
        return true;
      };
      await dialog.getByRole('button', { name: 'Make public', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      assert.equal(state.lesson.status, 'private');
      await dialog.getByRole('radio', { name: 'Private', exact: true }).focus();
      await page.keyboard.press('Space');
      await dialog.getByRole('button', { name: 'Share with 1 user', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(state.writes.map(write => write.expectedVersion), [1, 1]);
      assert.equal(state.lesson.status, 'private');
      assert.deepEqual(state.lesson.sharedWith, ['learner']);
    } finally { await context.close(); }
  });

  it('shows the pending public choice when visibility recovery is reopened or reloaded', async () => {
    for (const reload of [false, true]) {
      const { context, page, state } = await fixture({ draft: false });
      try {
        state.beforeWrite = async route => { await route.abort('failed'); return true; };
        await page.getByRole('button', { name: 'Make public', exact: true }).click();
        await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor();
        const original = structuredClone(state.writes[0]);
        if (reload) {
          page.once('dialog', dialog => dialog.accept());
          await page.reload();
          await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor();
        }
        await page.getByRole('button', { name: /Visibility and sharing.*Private/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Visibility & Sharing' });
        assert.equal(await dialog.getByRole('radio', { name: 'Public', exact: true }).isChecked(), true);
        assert.equal(await dialog.getByRole('radio', { name: 'Public', exact: true }).isDisabled(), true);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByRole('button', { name: /Visibility and sharing.*Private/ }).click();
        assert.equal(await dialog.getByRole('radio', { name: 'Public', exact: true }).isChecked(), true);
        state.beforeWrite = null;
        await dialog.getByRole('button', { name: 'Retry saving', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: /Visibility and sharing.*Public/ }).waitFor();
        assert.deepEqual(state.writes.at(-1), original);
        assert.equal(state.aiCalls, 0);
      } finally { await context.close(); }
    }
  });

  it('makes public lessons private without adding recipients in the editor and list', async () => {
    for (const fromList of [false, true]) {
      const { context, page, state } = await fixture({ draft: false });
      try {
        state.lesson.status = 'public';
        state.lesson.sharedWith = [];
        await page.goto(`${base}/plato/lessons${fromList ? '' : '/publishing/edit'}`);
        await page.getByRole('button', { name: /Visibility and sharing.*Public/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Visibility & Sharing' });
        await dialog.getByRole('radio', { name: 'Private', exact: true }).focus();
        await page.keyboard.press('Space');
        await dialog.getByRole('button', { name: 'Make private', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: /Visibility and sharing.*Private/ }).waitFor();
        assert.equal(state.lesson.status, 'private');
        assert.deepEqual(state.lesson.sharedWith, []);
      } finally { await context.close(); }
    }
  });

  it('allows a rejected public preview to be revised and saved privately', async () => {
    const { context, page, state } = await fixture();
    try {
      await review(page);
      state.beforeWrite = async route => {
        state.beforeWrite = null;
        await route.fulfill({ status: 400, json: { error: 'The lesson needs valid learning objectives.' } });
        return true;
      };
      await page.getByRole('button', { name: 'Save & make public', exact: true }).click();
      await page.getByRole('button', { name: 'Revise lesson', exact: true }).click();
      await review(page);
      await page.getByRole('button', { name: 'Save privately', exact: true }).click();
      await page.waitForURL(`${base}/plato/lessons`);
      assert.equal(state.lesson.status, 'private');
      assert.equal(state.writes.length, 2);
      assert.equal(state.writes[1].status, 'private');
    } finally { await context.close(); }
  });

  it('preserves reviewed work and blocks publishing after a version conflict', async () => {
    const { context, page, state } = await fixture();
    try {
      await review(page);
      state.beforeWrite = async route => {
        await route.fulfill({ status: 409, json: { error: 'This lesson changed in another session.' } });
        return true;
      };
      await page.getByRole('button', { name: 'Save & make public', exact: true }).click();
      await page.getByRole('button', { name: 'Load saved lesson', exact: true }).waitFor();
      assert.equal(state.lesson.status, 'draft');
      assert.equal(state.writes.length, 1);
      const recovered = await page.evaluate(() => {
        const key = Object.keys(sessionStorage).find(key => key.startsWith('plato_lesson_recovery:'));
        return JSON.parse(sessionStorage.getItem(key));
      });
      assert.equal(recovered.snapshot.previewMarkdown, markdown);
      assert.equal(recovered.operations[0].body.status, 'public');
      assert.equal(await page.getByRole('button', { name: 'Retry saving lesson', exact: true }).isDisabled(), true);
    } finally { await context.close(); }
  });

  it('opens sharing from the list status by keyboard and keeps failures in the dialog', async () => {
    const { context, page, state } = await fixture({ draft: false, width: 320 });
    try {
      await page.goto(`${base}/plato/lessons`);
      const status = page.getByRole('button', { name: /Visibility and sharing.*Private/ });
      assert.match(await status.innerText(), /Private/);
      await page.screenshot({ path: join(publishingEvidence, 'list-320-private.png'), fullPage: true });
      await status.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Visibility & Sharing' });
      await dialog.getByRole('radio', { name: 'Public', exact: true }).focus();
      await page.keyboard.press('Space');
      state.beforeWrite = async route => {
        state.beforeWrite = null;
        await route.fulfill({ status: 503, json: { error: 'Publishing is unavailable. Try again.' } });
        return true;
      };
      await dialog.getByRole('button', { name: 'Make public', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: 'Publishing is unavailable' }).waitFor();
      assert.equal(await dialog.getByRole('radio', { name: 'Public', exact: true }).isChecked(), true);
      assert.equal(state.lesson.status, 'private');
      await dialog.getByRole('button', { name: 'Make public', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: /Visibility and sharing.*Public/ }).waitFor();
      await page.screenshot({ path: join(publishingEvidence, 'list-320-public.png'), fullPage: true });
      assert.deepEqual(state.lesson.sharedWith, ['learner']);
    } finally { await context.close(); }
  });

  it('keeps publishing controls within desktop and narrow light/dark viewports', async () => {
    await mkdir(publishingEvidence, { recursive: true });
    for (const width of [320, 1280]) for (const theme of ['light', 'dark']) {
      const { context, page } = await fixture({ width, theme });
      try {
        await review(page);
        for (const name of ['Save privately', 'Save & make public']) {
          const button = page.getByRole('button', { name, exact: true });
          assert.equal(await button.isEnabled(), true);
          const box = await button.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width, `${name} fits at ${width}px ${theme}`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: join(publishingEvidence, `editor-${width}-${theme}.png`), fullPage: true });
      } finally { await context.close(); }
    }
  });

  it('keeps both mobile save choices together immediately after short and long previews', async () => {
    for (const theme of ['light', 'dark']) for (const long of [false, true]) {
      const { context, page, state } = await fixture({ width: 320, theme });
      try {
        if (long) state.previewMarkdown = markdown.replace('Write a clear summary.',
          `Write a clear summary.\n\n${'Read the scenario carefully and explain the main idea in your own words.\n\n'.repeat(60)}`);
        await review(page);
        const actions = page.getByRole('group', { name: 'Save lesson', exact: true });
        const preview = page.getByRole('complementary', { name: 'Lesson markdown preview' });
        await actions.waitFor();
        const afterPreview = await actions.evaluate((element) => {
          const preview = document.querySelector('aside[aria-label="Lesson markdown preview"]');
          return Boolean(preview.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        assert.equal(afterPreview, true, 'commit controls follow the material being reviewed in reading order');
        assert.equal(await actions.getByRole('button', { name: 'Start over', exact: true }).count(), 0);
        const previewBody = preview.locator('.markdown-preview-body');
        assert.equal(await previewBody.evaluate(element => element.scrollHeight <= element.clientHeight + 1), true,
          'narrow previews use the page flow instead of a nested scrollport');
        await page.locator('#main-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
        const main = await page.locator('#main-content').boundingBox();
        for (const name of ['Save privately', 'Save & make public']) {
          const button = actions.getByRole('button', { name, exact: true });
          const box = await button.boundingBox();
          assert.ok(box.y >= main.y - 1 && box.y + box.height <= main.y + main.height + 1, `${name} is visible after review`);
          assert.equal(await button.evaluate(element => {
            const box = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          }), true, `${name} remains unobstructed`);
        }
        assert.equal(state.writes.length, 0);
        await page.screenshot({ path: join(mobileEvidence, `review-end-${theme}-${long ? 'long' : 'short'}.png`), fullPage: false });
      } finally { await context.close(); }
    }
  });

  it('explains readiness while preserving the three-out-of-ten creation threshold', async () => {
    for (const readiness of [2, 3, 8]) {
      const { context, page, state } = await fixture({ width: 320, readiness });
      try {
        await page.locator('.lesson-editor-readiness-toggle').click();
        await page.getByText('How fully your lesson has been defined in this conversation.', { exact: true }).waitFor();
        const help = page.locator('summary').filter({ hasText: 'About lesson readiness' });
        await help.focus();
        await page.keyboard.press('Enter');
        const rubric = page.getByRole('region', { name: 'Readiness guidance', exact: true });
        assert.match(await rubric.innerText(), /3\/10/);
        assert.match(await rubric.innerText(), /exemplar|outcome/i);
        assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), String(readiness));
        await review(page);
        assert.equal(await page.getByRole('button', { name: 'Save privately', exact: true }).isDisabled(), readiness < 3);
        assert.equal(await page.getByRole('button', { name: 'Save & make public', exact: true }).isDisabled(), readiness < 3);
        assert.equal(state.writes.length, 0);
      } finally { await context.close(); }
    }
  });

  it('transfers focus when responsive controls disappear and retains open readiness guidance', async () => {
    const { context, page, state } = await fixture({ width: 390 });
    try {
      for (const name of ['Refine', 'Preview', 'readiness', 'View preview']) {
        await page.setViewportSize({ width: 390, height: 900 });
        await page.getByRole('tab', { name: 'Refine', exact: true }).click();
        const control = name === 'readiness' ? page.locator('.lesson-editor-readiness-toggle')
          : name === 'View preview' ? page.getByRole('button', { name, exact: true })
            : page.getByRole('tab', { name, exact: true });
        await control.focus();
        await page.setViewportSize({ width: 1280, height: 900 });
        const selector = name === 'readiness' ? '.lesson-editor-readiness [role="progressbar"]'
          : name === 'Refine' ? '#lesson-refine-heading' : '#lesson-preview-panel > [aria-label="Lesson preview"]';
        await page.waitForFunction(selector => document.querySelector(selector) === document.activeElement, selector);
        assert.equal(await page.locator(selector).isVisible(), true, `${name} transfers focus to visible content`);
      }
      await page.getByText('About lesson readiness', { exact: true }).focus();
      await page.setViewportSize({ width: 390, height: 900 });
      const guidance = page.getByText('About lesson readiness', { exact: true });
      await guidance.waitFor();
      assert.equal(await guidance.evaluate(element => element === document.activeElement), true,
        'narrowing keeps the focused readiness content visible');
      assert.equal(state.aiCalls, 0);
      assert.equal(state.writes.length, 0);
    } finally { await context.close(); }
  });

  it('preserves the composer and reviewed preview through keyboard tabs, resizing and enlarged text', async () => {
    const { context, page, state } = await fixture({ width: 320 });
    try {
      const refine = page.getByRole('tab', { name: 'Refine', exact: true });
      const preview = page.getByRole('tab', { name: 'Preview', exact: true });
      await page.getByRole('textbox', { name: 'Your message' }).fill('Keep this unfinished thought.');
      await refine.focus();
      await page.keyboard.press('End');
      assert.equal(await preview.getAttribute('aria-selected'), 'true');
      assert.equal(await preview.evaluate(element => element === document.activeElement), true);
      assert.equal(await page.getByRole('textbox', { name: 'Your message' }).count(), 0);
      await review(page);
      await preview.focus();
      await page.keyboard.press('Home');
      assert.equal(await page.getByRole('textbox', { name: 'Your message' }).inputValue(), 'Keep this unfinished thought.');
      await page.getByRole('button', { name: 'View preview', exact: true }).click();
      assert.equal(await page.getByRole('complementary', { name: 'Lesson markdown preview' }).isVisible(), true);
      assert.equal(state.aiCalls, 1, 'switching tabs does not generate a preview');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('textbox', { name: 'Your message' }).waitFor();
      assert.equal(await page.getByRole('tablist', { name: 'Lesson workspace' }).count(), 0);
      assert.equal(await page.getByRole('complementary', { name: 'Lesson markdown preview' }).isVisible(), true);
      await page.getByRole('button', { name: 'Save privately', exact: true }).focus();
      await page.setViewportSize({ width: 320, height: 900 });
      await preview.waitFor();
      assert.equal(await preview.getAttribute('aria-selected'), 'true', 'narrowing retains the panel with keyboard focus');
      assert.equal(await page.getByRole('button', { name: 'Save privately', exact: true }).evaluate(element => element === document.activeElement), true);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
      await preview.waitFor();
      assert.equal(await preview.getAttribute('aria-selected'), 'true');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(workspaceEvidence, 'preview-enlarged-text.png'), fullPage: true });
      await refine.click();
      assert.equal(await page.getByRole('textbox', { name: 'Your message' }).inputValue(), 'Keep this unfinished thought.');
      assert.equal(state.writes.length, 0, 'view changes never finalize or autosave content');
    } finally { await context.close(); }
  });

  it('keeps the saved public lesson visible and blocks updates until a refreshed preview is ready', async () => {
    const { context, page, state } = await fixture({ draft: false, lesson: {
      status: 'public', conversationRevision: 'revised-conversation',
    } });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      const update = page.getByRole('button', { name: 'Update lesson', exact: true });
      const preview = page.getByRole('complementary', { name: 'Lesson markdown preview' });
      await preview.getByText('Needs refresh', { exact: true }).waitFor();
      await preview.getByText('Currently saved content', { exact: true }).waitFor();
      assert.equal(await update.isDisabled(), true);
      await update.focus();
      await page.keyboard.press('Enter');
      assert.equal(state.writes.length, 0);
      assert.equal(state.aiCalls, 0, 'the disabled update does not extract or save');
      state.previewMarkdown = markdown.replace('clear summary', 'clear summary with an owner and due date');
      state.beforeAI = async () => { await gate; return false; };
      await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
      await preview.getByText('Refreshing preview…', { exact: true }).waitFor();
      assert.equal(await preview.locator('.coach-copy').isVisible(), true);
      assert.match(await preview.locator('.coach-copy').innerText(), /Write a clear summary\./);
      assert.equal(await update.isDisabled(), true);
      release();
      await preview.getByText('Preview current · Changes not applied', { exact: true }).waitFor();
      assert.equal(await update.isEnabled(), true);
      assert.equal(state.lesson.markdown, markdown, 'refreshing does not change the public lesson');
      await update.click();
      await page.waitForURL(`${base}/plato/lessons`);
      assert.equal(state.lesson.markdown, state.previewMarkdown);
      assert.equal(state.lesson.status, 'public');
      assert.equal(state.aiCalls, 1);
    } finally { release(); await context.close(); }
  });

  it('retains saved content after a failed refresh and allows an explicit retry', async () => {
    const { context, page, state } = await fixture({ draft: false, width: 320, theme: 'dark', lesson: {
      status: 'public', conversationRevision: 'revised-conversation',
    } });
    try {
      await page.getByRole('tab', { name: 'Preview', exact: true }).click();
      state.previewMarkdown = '# Incomplete lesson';
      await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
      const preview = page.getByRole('complementary', { name: 'Lesson markdown preview' });
      await preview.getByRole('alert').waitFor();
      assert.equal(await preview.getByRole('heading', { name: 'Reviewed Lesson', exact: true }).isVisible(), true);
      assert.equal(await page.getByRole('button', { name: 'Update lesson', exact: true }).isDisabled(), true);
      assert.equal(state.writes.length, 0);
      await page.screenshot({ path: join(workspaceEvidence, 'refresh-failed-320-dark.png'), fullPage: true });
      state.previewMarkdown = markdown;
      await review(page);
      await preview.getByRole('alert').waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('button', { name: 'Update lesson', exact: true }).isEnabled(), true);
      assert.equal(state.aiCalls, 2);
    } finally { await context.close(); }
  });

  it('offers refresh beside the stale notice before a long mobile preview', async () => {
    const { context, page, state } = await fixture({ draft: false, width: 320, height: 568, theme: 'dark', lesson: {
      status: 'public', conversationRevision: 'revised-conversation',
      markdown: markdown.replace('Write a clear summary.', 'Describe progress, the blocker, an owner and a due date.\n\n'.repeat(30)),
    } });
    try {
      await page.getByRole('tab', { name: 'Preview', exact: true }).click();
      await page.locator('#main-content').evaluate(element => { element.scrollTop = 0; });
      const refresh = page.getByRole('button', { name: 'Refresh preview', exact: true });
      const position = await refresh.evaluate(element => {
        const box = element.getBoundingClientRect();
        const main = document.querySelector('#main-content').getBoundingClientRect();
        return { visible: box.top >= main.top && box.bottom <= main.bottom,
          beforeContent: !!(element.compareDocumentPosition(document.querySelector('.markdown-preview-body')) & Node.DOCUMENT_POSITION_FOLLOWING) };
      });
      await page.screenshot({ path: join(workspaceEvidence, 'stale-refresh-first-screen-320-dark.png') });
      assert.equal(position.visible, true, 'refresh is available without scrolling through outdated content');
      assert.equal(position.beforeContent, true, 'refresh precedes the content it regenerates');
      assert.equal(await page.getByRole('button', { name: 'Update lesson', exact: true }).isDisabled(), true);
      assert.equal(state.aiCalls, 0);
      assert.equal(state.writes.length, 0);
    } finally { await context.close(); }
  });

  it('keeps refresh errors visible with focus on the initiating control for long mobile previews', async () => {
    for (const [width, height] of [[320, 568], [390, 844]]) {
      const savedMarkdown = markdown.replace('Write a clear summary.', 'Choose concrete details for the audience.\n\n'.repeat(30));
      const { context, page, state } = await fixture({ draft: false, width, height, theme: 'dark', lesson: {
        status: 'public', conversationRevision: 'revised-conversation', markdown: savedMarkdown,
      } });
      try {
        await page.getByRole('tab', { name: 'Preview', exact: true }).click();
        state.previewMarkdown = '# Incomplete lesson';
        const refresh = page.getByRole('button', { name: 'Refresh preview', exact: true });
        await refresh.click();
        const alert = page.getByRole('alert');
        await alert.waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ path: join(workspaceEvidence, `refresh-error-visible-${width}-dark.png`) });
        assert.equal(await alert.evaluate(element => {
          const box = element.getBoundingClientRect();
          const main = document.querySelector('#main-content').getBoundingClientRect();
          return box.top >= main.top && box.bottom <= main.bottom;
        }), true, 'the failure is visible where the author initiated refresh');
        assert.equal(await refresh.evaluate(element => element === document.activeElement), true, 'failed refresh retains control focus');
        const errorId = await alert.getAttribute('id');
        assert.ok(errorId && (await refresh.getAttribute('aria-describedby'))?.split(' ').includes(errorId),
          'the refresh control describes its validation failure');
        assert.equal(await page.getByRole('button', { name: 'Update lesson', exact: true }).isDisabled(), true);
        assert.equal(state.lesson.markdown, savedMarkdown);
        assert.equal(state.writes.length, 0);
      } finally { await context.close(); }
    }
  });

  it('preserves refinement focus and scroll when a background refresh fails', async () => {
    const { context, page, state } = await fixture({ draft: false, width: 390, height: 844, lesson: { status: 'public' } });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      state.previewMarkdown = '# Incomplete lesson';
      state.beforeAI = async () => { await gate; return false; };
      await page.getByRole('tab', { name: 'Preview', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
      await page.getByRole('tab', { name: 'Refine', exact: true }).click();
      const composer = page.getByRole('textbox', { name: 'Your message' });
      await composer.fill('Keep this unsent revision.');
      await composer.focus();
      const main = page.locator('#main-content');
      const position = await main.evaluate(element => element.scrollTop);
      release();
      await page.locator('#lesson-preview-panel [role="alert"]').waitFor({ state: 'attached' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await composer.evaluate(element => element === document.activeElement), true);
      assert.equal(await main.evaluate(element => element.scrollTop), position);
      assert.equal(await composer.inputValue(), 'Keep this unsent revision.');
      assert.equal(state.writes.length, 0);
    } finally { release(); await context.close(); }
  });

  it('opens mobile authoring at its heading and workspace tabs and follows an explicit new message', async () => {
    for (const [width, height] of [[320, 568], [390, 844], [430, 932]]) {
      const { context, page, state } = await fixture({ width, height, lesson: {
        conversation: [
          { role: 'assistant', content: 'What should a learner be able to produce by the end?' },
          { role: 'user', content: 'A three-sentence update with progress, a blocker and the next action.' },
          { role: 'assistant', content: 'Review the exemplar and objectives, or tell me what to change.' },
        ],
      } });
      try {
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const main = page.locator('#main-content');
        await page.screenshot({ path: join(workspaceEvidence, `editor-entry-${width}-light.png`) });
        assert.equal(await main.evaluate(element => element.scrollTop), 0, 'opening the editor preserves its page context');
        for (const control of [page.getByRole('heading', { name: 'New Lesson', exact: true }), page.getByRole('tablist', { name: 'Lesson workspace' })]) {
          assert.equal(await control.evaluate(element => {
            const box = element.getBoundingClientRect();
            const main = document.querySelector('#main-content').getBoundingClientRect();
            return box.top >= main.top && box.bottom <= main.bottom;
          }), true, 'the title and workspace tabs are visible on entry');
        }
        assert.equal(state.writes.length, 0);
        const composer = page.getByRole('textbox', { name: 'Your message' });
        await composer.fill('Require an owner and a due date.');
        await composer.focus();
        await main.evaluate(element => { element.scrollTop = 0; });
        await composer.press('Control+Enter');
        await page.getByRole('status').filter({ hasText: /Reply received/ }).waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.ok(await main.evaluate(element => element.scrollTop) > 0, 'an explicit submission still follows the newest turn');
        const endpoint = await page.getByRole('button', { name: 'View preview', exact: true }).evaluate(element => {
          const box = element.getBoundingClientRect();
          const main = document.querySelector('#main-content').getBoundingClientRect();
          return { visible: box.bottom <= main.bottom, bottom: box.bottom, mainBottom: main.bottom,
            scrollTop: document.querySelector('#main-content').scrollTop,
            scrollHeight: document.querySelector('#main-content').scrollHeight };
        });
        if (!endpoint.visible) await page.screenshot({ path: join(workspaceEvidence, `editor-submitted-${width}-light.png`) });
        assert.equal(endpoint.visible, true, `following reaches the composer endpoint: ${JSON.stringify(endpoint)}`);
      } finally { await context.close(); }
    }
  });

  it('keeps a background refresh stale when the author continues refining on mobile', async () => {
    const { context, page, state } = await fixture({ draft: false, width: 390, lesson: { status: 'public' } });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      state.beforeAI = async route => {
        if (!route.request().postDataJSON().stream) await gate;
        return false;
      };
      await page.getByRole('tab', { name: 'Preview', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
      await page.getByRole('tab', { name: 'Refine', exact: true }).click();
      const composer = page.getByRole('textbox', { name: 'Your message' });
      await composer.fill('Require an owner and a due date.');
      await composer.press('Control+Enter');
      await page.getByRole('status').filter({ hasText: /Reply received/ }).waitFor();
      await composer.fill('An unsent follow-up.');
      await composer.focus();
      release();
      await page.waitForFunction(() => document.querySelector('.markdown-preview-body')?.getAttribute('aria-busy') === 'false');
      assert.equal(await composer.evaluate(element => element === document.activeElement), true, 'background completion does not steal focus');
      await page.getByRole('tab', { name: 'Preview', exact: true }).click();
      await page.getByText('Needs refresh', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Update lesson', exact: true }).isDisabled(), true);
      assert.equal(state.writes.every(write => write.markdown === undefined), true, 'conversation autosaves do not apply preview content');
      await review(page);
      assert.equal(await page.getByRole('button', { name: 'Update lesson', exact: true }).isEnabled(), true);
      await page.getByRole('tab', { name: 'Refine', exact: true }).click();
      assert.equal(await composer.inputValue(), 'An unsent follow-up.');
    } finally { release(); await context.close(); }
  });

  it('stops following a pending authoring reply when the author scrolls away', async () => {
    const { context, page, state } = await fixture({ width: 390, height: 844, lesson: {
      conversation: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user', content: 'Keep the update focused on a concrete next action with an owner and due date.',
      })),
    } });
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const called = new Promise(resolve => { started = resolve; });
    try {
      state.beforeAI = async () => { started(); await gate; return false; };
      const composer = page.getByRole('textbox', { name: 'Your message' });
      await composer.fill('Require a clear owner.');
      await composer.press('Control+Enter');
      await called;
      await page.waitForFunction(() => document.querySelector('#main-content').scrollTop > 100);
      await page.locator('#main-content').evaluate(element => { element.scrollTop = 0; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      release();
      await page.getByRole('status').filter({ hasText: /Reply received/ }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#main-content').evaluate(element => element.scrollTop), 0,
        'an actual scroll away stops following the pending reply');
      assert.equal(state.aiCalls, 1);
    } finally { release(); await context.close(); }
  });

  it('resumes following when the first mobile scroll reaches the composer after narrowing', async () => {
    const { context, page, state } = await fixture({ width: 1280, lesson: {
      conversation: Array.from({ length: 16 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user', content: 'Keep the update focused on a concrete next action with an owner and due date.',
      })),
    } });
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const called = new Promise(resolve => { started = resolve; });
    try {
      state.beforeAI = async route => {
        started();
        await gate;
        await route.fulfill({ json: { content: [{ type: 'text', text:
          `${'Keep each requirement specific and connected to the outcome. '.repeat(15)}[READINESS: 8]` }] } });
        return true;
      };
      const composer = page.getByRole('textbox', { name: 'Your message' });
      await composer.fill('Require a clear owner.');
      await composer.press('Control+Enter');
      await called;
      await page.waitForFunction(() => window.scrollY > 100);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('tabpanel', { name: 'Refine', exact: true }).waitFor();
      // Reach the composer with one small bottom gutter; the endpoint is before
      // the page padding, so scrolling beyond it tests a different position.
      await page.locator('#main-content').evaluate(element => {
        element.scrollTop = element.scrollHeight - element.clientHeight - 16;
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      release();
      await page.getByRole('status').filter({ hasText: /Reply received/ }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByRole('button', { name: 'View preview', exact: true }).evaluate(element => {
        const box = element.getBoundingClientRect();
        const main = document.querySelector('#main-content').getBoundingClientRect();
        return box.bottom <= main.bottom;
      }), true, 'the first movement in the new mobile scrollport resumes following');
    } finally { release(); await context.close(); }
  });

  it('keeps the mobile review position while a hidden conversation receives its reply', async () => {
    const { context, page, state } = await fixture({ draft: false, width: 390, lesson: {
      markdown: markdown.replace('Write a clear summary.', `Write a clear summary.\n\n${'Consider the audience and choose specific details.\n\n'.repeat(30)}`),
    } });
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const called = new Promise(resolve => { started = resolve; });
    try {
      state.beforeAI = async () => { started(); await gate; return false; };
      const composer = page.getByRole('textbox', { name: 'Your message' });
      await composer.fill('Make the next action more specific.');
      await composer.press('Control+Enter');
      await called;
      await page.getByRole('tab', { name: 'Preview', exact: true }).click();
      const main = page.locator('#main-content');
      await main.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
      const position = await main.evaluate(element => element.scrollTop);
      assert.ok(position > 100, 'the review is scrolled away from its header');
      release();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="status"]')).some(element => element.textContent.includes('Reply received.')));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await main.evaluate(element => element.scrollTop), position, 'the hidden chat never scrolls the review');
      assert.equal(await page.getByRole('tab', { name: 'Preview', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(state.writes.every(write => write.markdown === undefined), true);
    } finally { release(); await context.close(); }
  });

  it('keeps the selected tab in place when returning from a scrolled preview to a long conversation', async () => {
    for (const pendingReply of [false, true]) {
      const { context, page, state } = await fixture({ draft: false, width: 390, lesson: {
        conversation: Array.from({ length: 12 }, (_, index) => ({
          role: index % 2 ? 'assistant' : 'user',
          content: 'Keep the project update focused on progress, a blocker, and a clear next action with an owner.',
        })),
        markdown: markdown.replace('Write a clear summary.', `Write a clear summary.\n\n${'Choose specific details for the audience.\n\n'.repeat(40)}`),
      } });
      let release = () => {};
      try {
        const main = page.locator('#main-content');
        // Recreate the formerly pinned position explicitly; editor entry now
        // stays at the heading, while this regression concerns tab return.
        await main.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.waitForFunction(() => document.querySelector('#main-content').scrollTop > 100);
        if (pendingReply) {
          let started;
          const gate = new Promise(resolve => { release = resolve; });
          const called = new Promise(resolve => { started = resolve; });
          state.beforeAI = async () => { started(); await gate; return false; };
          const composer = page.getByRole('textbox', { name: 'Your message' });
          await composer.fill('Require a specific owner for the next action.');
          await composer.press('Control+Enter');
          await called;
        }
        await page.getByRole('tab', { name: 'Preview', exact: true }).click();
        await main.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
        const refine = page.getByRole('tab', { name: 'Refine', exact: true });
        await refine.focus();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const position = await main.evaluate(element => element.scrollTop);
        await refine.press('Enter');
        await page.getByRole('textbox', { name: 'Your message' }).waitFor();
        release();
        if (pendingReply) await page.getByRole('status').filter({ hasText: /Reply received/ }).waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await main.evaluate(element => element.scrollTop), position,
          'revealing the chat does not reuse its old pinned position');
        assert.equal(await refine.evaluate(element => {
          const box = element.getBoundingClientRect();
          const main = document.querySelector('#main-content').getBoundingClientRect();
          return box.top >= main.top && box.bottom <= main.bottom;
        }), true, 'the selected tab remains visible');
        assert.equal(state.aiCalls, pendingReply ? 1 : 0);
        assert.equal(state.writes.every(write => write.markdown === undefined), true);
      } finally { release(); await context.close(); }
    }
  });

  it('renders the selected create, public-edit and mobile-review concepts with sample content', async () => {
    const sampleMarkdown = '# Write a useful project update\n\n## Exemplar\nWrite a three-sentence project update that states progress, a blocker, and the next action.\n\n## Learning Objectives\n- Can separate progress from activity.\n- Can describe one blocker clearly.\n- Can name a next action and owner.';
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      const { context, page, state } = await fixture({ width, theme, lesson: {
        course: 'communication',
        conversation: [
          { role: 'assistant', content: 'What should a learner be able to produce by the end?' },
          { role: 'user', content: 'A three-sentence update: progress, a blocker, and the next action.' },
          { role: 'assistant', content: 'I’ve shaped that into one outcome and three objectives. Review the preview, or tell me what to change.' },
        ],
      } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        // WebKit reports this unsupported, existing progressive-enhancement hint
        // as an error. Keep all application errors and other console output gated.
        if (message.type() === 'error' && !(browserName === 'webkit'
          && message.text() === 'Viewport argument key "interactive-widget" not recognized and ignored.')) errors.push(message.text());
      });
      try {
        await context.route('**/v1/admin/courses', route => route.fulfill({ json: [{ courseId: 'communication', name: 'Workplace communication' }] }));
        await page.reload();
        if (width === 390) {
          await page.getByRole('tab', { name: 'Refine', exact: true }).waitFor();
          await page.locator('#main-content').evaluate(element => { element.scrollTop = 0; });
          await page.screenshot({ path: join(workspaceEvidence, `create-refine-${width}-${theme}.png`), fullPage: true });
          await page.getByRole('button', { name: 'View preview', exact: true }).click();
        }
        state.previewMarkdown = sampleMarkdown;
        await page.getByRole('button', { name: 'Generate preview', exact: true }).click();
        await page.getByText('Preview current · Not saved as a lesson', { exact: true }).waitFor();
        await page.screenshot({ path: join(workspaceEvidence, `create-preview-${width}-${theme}.png`), fullPage: true });
        state.lesson = { ...state.lesson, status: 'public', markdown: sampleMarkdown, markdownRevision: 'older-revision',
          conversation: [
            { role: 'assistant', content: 'What would you like to change in this lesson?' },
            { role: 'user', content: 'Keep the three-sentence format, but require an owner and a due date for the next action.' },
            { role: 'assistant', content: 'I’ll include both in the next-action requirement. Refresh the preview to review the revised lesson.' },
          ] };
        await page.evaluate(() => sessionStorage.clear());
        await page.reload();
        if (width === 390) await page.getByRole('tab', { name: 'Preview', exact: true }).click();
        await page.getByText('Needs refresh', { exact: true }).waitFor();
        await page.screenshot({ path: join(workspaceEvidence, `edit-stale-${width}-${theme}.png`), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, [], 'sample flows have no browser console errors');
      } finally { await context.close(); }
    }
  });

  it('offers mobile lesson rows with keyboard filters, metrics and named actions', async () => {
    const { context, page, state } = await fixture({ draft: false, width: 320 });
    try {
      state.lesson.name = 'A long lesson title that remains readable while changing visibility and managing the lesson';
      await page.goto(`${base}/plato/lessons`);
      const list = page.getByRole('list', { name: 'Lessons', exact: true });
      await list.waitFor();
      assert.equal(await page.getByRole('table', { name: 'Lessons', exact: true }).count(), 0);
      assert.equal(await list.getByRole('button', { name: /Visibility and sharing.*Private/ }).isVisible(), true);
      assert.equal(await page.getByRole('combobox', { name: 'Filter by visibility', exact: true }).count(), 0);
      await page.locator('summary').filter({ hasText: /^Filters/ }).focus();
      await page.keyboard.press('Enter');
      const visibility = page.getByRole('combobox', { name: 'Filter by visibility', exact: true });
      await visibility.selectOption('draft');
      await list.getByText('No lessons match these filters.', { exact: true }).waitFor();
      await visibility.selectOption('private');
      await list.getByRole('button', { name: /Edit A long lesson title/ }).waitFor();
      await list.locator('summary').filter({ hasText: 'Lesson metrics' }).focus();
      await page.keyboard.press('Enter');
      assert.equal(await list.getByText('Completions', { exact: true }).isVisible(), true);
      const actions = list.getByRole('button', { name: /^Actions for/ });
      await actions.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Delete lesson', exact: true }).click();
      const confirm = page.getByRole('alertdialog');
      await confirm.waitFor();
      assert.match(await confirm.innerText(), /Delete Lesson/);
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      await confirm.waitFor({ state: 'hidden' });
      assert.equal(await actions.evaluate(element => document.activeElement === element), true, 'Cancel returns focus to the row actions');
      assert.equal(await list.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      assert.equal(await page.locator('summary').filter({ hasText: /^Filters/ }).evaluate(element => document.activeElement === element), true,
        'clearing filters keeps focus on a surviving filter control');
      await page.screenshot({ path: join(mobileEvidence, 'list-320.png'), fullPage: true });
      await actions.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Edit lesson', exact: true }).click();
      await page.getByRole('heading', { name: 'Edit Lesson', exact: true }).waitFor();
    } finally { await context.close(); }
  });

  it('saves reviewed content and public visibility through the real local API and SQLite', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState });
    try {
      const page = await context.newPage();
      await page.goto(`${base}/plato/lessons`);
      const token = await page.evaluate(() => JSON.parse(localStorage.getItem('plato_auth')).accessToken);
      const headers = { Authorization: `Bearer ${token}` };
      const created = await context.request.put(`${base}/v1/admin/lessons/real-publishing`, { headers, data: {
        status: 'draft', name: 'Untitled draft', expectedVersion: 0, operationId: 'create-browser-draft', readiness: 8,
        conversation: [{ role: 'assistant', content: 'The lesson is ready for review.' }], conversationRevision: 'review-1',
      } });
      assert.equal(created.status(), 200);
      let aiCalls = 0;
      await context.route('**/v1/ai/messages', route => {
        aiCalls++;
        return route.fulfill({ json: { content: [{ type: 'text', text: markdown }] } });
      });
      await page.goto(`${base}/plato/lessons/real-publishing/edit`);
      await review(page);
      await page.getByRole('button', { name: 'Save & make public', exact: true }).click();
      await page.waitForURL(`${base}/plato/lessons`);
      await page.getByRole('button', { name: 'Visibility and sharing for Reviewed Lesson: Public', exact: true }).waitFor();
      const response = await context.request.get(`${base}/v1/admin/lessons/real-publishing`, { headers });
      assert.equal(response.status(), 200);
      const saved = await response.json();
      assert.equal(saved.status, 'public');
      assert.equal(saved.markdown, markdown);
      assert.equal(saved.version, 2);
      assert.equal(aiCalls, 1, 'only explicit preview generation calls the fixture AI');
    } finally { await context.close(); }
  });
});
