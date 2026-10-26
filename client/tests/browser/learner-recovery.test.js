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
    await page.getByText('Your reply is saved.', { exact: true }).waitFor();
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
    await page.getByText('Your reply is saved.', { exact: true }).waitFor();
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

  it('acknowledges unchanged profile feedback without writes and still retains malformed responses', t => withPage(t, async page => {
    await page.goto(`${base}/settings`);
    let result = { changed: false };
    const writes = [];
    page.on('request', request => {
      if (request.method() === 'PUT' && /\/v1\/sync\/profile(?:Summary)?$/.test(request.url())) writes.push(request.url());
    });
    await page.route('**/v1/ai/messages', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }) }));
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Profile feedback', exact: true });
    await input.fill('My profile already describes my preferences.');
    await page.getByRole('button', { name: 'Update profile', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add Profile Feedback' }).waitFor({ state: 'hidden', timeout: 3000 });
    await page.getByRole('status').filter({ hasText: 'Your profile is already up to date.' }).waitFor();
    assert.deepEqual(writes, []);
    await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
    assert.equal(await input.inputValue(), '');
    result = {};
    await input.fill('Retain this feedback if the response is malformed.');
    await page.getByRole('button', { name: 'Update profile', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'The profile update was empty.' }).waitFor();
    assert.equal(await input.inputValue(), 'Retain this feedback if the response is malformed.');
    assert.deepEqual(writes, []);
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
