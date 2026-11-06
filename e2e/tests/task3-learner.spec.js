import { test, expect } from '@playwright/test';
import { login, expectAccessible } from '../helpers.js';
import { LEARNER, LESSONS, PROGRAM, COURSE } from '../fixtures.js';
const ARTIFACTS = process.env.TASK3_EVIDENCE_DIR || '/tmp/plato-task3-browser-evidence';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
async function reset(request, id) {
  const { accessToken } = await (await request.post('/v1/auth/login', { data: LEARNER })).json();
  const status = await (await request.get('/v1/sync/status', { headers: { Authorization: `Bearer ${accessToken}` } })).json();
  const headers = { Authorization: `Bearer ${accessToken}`, 'X-Plato-Client-Protocol': status.protocol, 'X-Plato-Client-Epoch': status.epoch };
  expect((await request.delete(`/v1/sync/lessonKB:${id}`, { headers })).ok()).toBeTruthy();
  return headers;
}
const composer = page => page.getByRole('textbox', { name: 'Your message', exact: true });
async function open(page, id) {
  await login(page, LEARNER); await page.goto(`/lessons/${id}`);
  await expect(page.getByText(/Welcome! In this lesson/)).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: /^Behind this response/ })).toHaveCount(1);
}

test('signed repair, evidence overview and save-only retry retain exact activity; hierarchy counts survive filtering', async ({ page, request }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const id = LESSONS[0].id, headers = await reset(request, id);
  await open(page, id);
  await expect(page.getByRole('button', { name: 'Progress (0 of 2 Objectives): lesson overview' })).toBeVisible();
  await page.goto(`/lessons/${id}?view=work`);
  await expect(page.getByRole('dialog', { name: LESSONS[0].name })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  let generated = 0, failSave = true, retained;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith(`/v1/ai/coach/${id}`)) generated++; });
  await page.route(`**/v1/sync/lesson-turn/${id}`, route => {
    if (route.request().method() !== 'POST') return route.continue();
    retained = route.request().postDataJSON();
    return failSave ? route.fulfill({ status: 503, json: { error: 'Synthetic outage' } }) : route.continue();
  });
  await composer(page).fill('MOCK_NOTAGS MOCK_COMPLETE Concrete comparison with reasons.');
  await composer(page).press(`${MOD}+Enter`);
  await expect(page.getByRole('button', { name: 'Retry saving', exact: true })).toBeVisible({ timeout: 20000 });
  expect(generated).toBe(1); expect(retained.receipt).toMatch(/^v1\.[a-f0-9]{64}$/);
  expect(retained.assessmentRepair.succeeded).toBe(true);
  const signed = JSON.stringify(retained); failSave = false;
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue to next lesson: Lesson Two' })).toBeVisible();
  expect(JSON.stringify(retained)).toBe(signed); expect(generated).toBe(1);
  await page.getByRole('button', { name: /^Behind this response/ }).last().click();
  await expect(page.getByText('Repaired assessment metadata on the server', { exact: true })).toBeVisible();
  await expect(page.getByText(/Asked to update/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Progress (2 of 2 Objectives): lesson overview' }).click();
  const dialog = page.getByRole('dialog', { name: LESSONS[0].name });
  await expect(dialog.getByRole('list', { name: 'Objectives' }).getByRole('listitem').first()).toContainText(', met');
  await expectAccessible(page, { include: '[role=dialog]', label: 'signed objective overview' });
  await page.screenshot({ path: `${ARTIFACTS}/learner-overview-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${ARTIFACTS}/learner-overview-mobile.png` });
  await page.keyboard.press('Escape'); await page.goto('/lessons');
  await expect(page.getByRole('heading', { level: 2, name: PROGRAM.name })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: COURSE.name })).toBeVisible();
  await page.getByLabel('Course', { exact: true }).selectOption(PROGRAM.id);
  await page.getByLabel('Unit', { exact: true }).selectOption(COURSE.id);
  await page.getByLabel('Status', { exact: true }).selectOption('not-started');
  await expect(page.getByRole('progressbar', { name: `${PROGRAM.name} progress: 1 of 3 public lessons completed` })).toBeVisible();
  await expectAccessible(page, { label: 'hierarchy and card names' });
  const saved = await (await request.get(`/v1/sync/lesson-turn/${id}`, { headers })).json();
  expect(saved.messages.data.slice(-2)).toEqual(retained.messages); expect(errors).toEqual([]);
});

test('settings keep notes, split names, chat preferences and email opt-outs through reload', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await login(page, LEARNER); await page.goto('/settings');
  await page.getByLabel('First name', { exact: true }).fill('Lee'); await page.getByLabel(/^Last name/).fill('Learner');
  let releaseName;
  const nameGate = new Promise(resolve => { releaseName = resolve; });
  await page.route('**/v1/me', async route => {
    if (route.request().method() === 'PATCH') await nameGate;
    return route.continue();
  });
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('radio', { name: /^Enter/ })).toBeDisabled();
  releaseName();
  await expect(page.locator('#name-feedback')).toHaveText('Saved!');
  await page.getByRole('button', { name: 'Add Feedback', exact: true }).click();
  await page.getByRole('textbox', { name: 'Profile feedback' }).fill('I use a phone and prefer short examples.');
  await page.getByRole('button', { name: 'Update profile', exact: true }).click();
  const notes = page.getByRole('list', { name: 'Your notes' });
  await expect(notes).toContainText('I use a phone and prefer short examples.');
  await page.getByRole('radio', { name: /^Enter/ }).check(); await expect(page.locator('#chat-feedback')).toHaveText('Saved.');
  const receive = page.getByRole('checkbox', { name: 'Reminders to finish a lesson I started' });
  await expect(receive).toBeEnabled(); await receive.uncheck(); await expect(page.locator('#email-feedback')).toHaveText('Saved.');
  await page.reload(); await expect(receive).not.toBeChecked(); await expect(page.getByRole('radio', { name: /^Enter/ })).toBeChecked();
  await expect(notes).toContainText('I use a phone and prefer short examples.');
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectAccessible(page, { label: 'settings notes at 320px' });
  await page.screenshot({ path: `${ARTIFACTS}/settings-mobile.png`, fullPage: true });
  await notes.getByRole('button', { name: /^Remove note/ }).last().focus(); await page.keyboard.press('Enter');
  await expect(notes).toHaveCount(0);
  await page.getByRole('radio', { name: /^(⌘|Ctrl)\+Enter/ }).check(); await expect(page.locator('#chat-feedback')).toHaveText('Saved.');
  expect(errors).toEqual([]);
});

test('busy composer preserves newer draft through generation failure and reload', async ({ page, request }) => {
  const id = LESSONS[1].id; await reset(request, id); await open(page, id);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfcAAAAASUVORK5CYII=', 'base64');
  await page.route('**/v1/links/fetch', route => route.fulfill({ json: { url: route.request().postDataJSON().url, title: 'Synthetic source', text: 'Readable synthetic text.' } }));
  async function attach(prefix) {
    await page.locator('input[type=file]').setInputFiles(Array.from({ length: 4 }, (_, i) => ({ name: `${prefix}-${i}.png`, mimeType: 'image/png', buffer: png })));
    await expect(page.getByRole('button', { name: 'Maximum 4 images attached' })).toBeVisible();
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Attach a link', exact: true }).click();
      await page.getByRole('textbox', { name: 'Link URL' }).fill(`https://example.test/${prefix}/${i}`);
      await page.getByRole('textbox', { name: 'Link URL' }).press('Enter');
      await expect(page.getByRole('textbox', { name: 'Link URL' })).toBeHidden();
    }
  }
  await composer(page).fill('Earlier full submission'); await attach('earlier');
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/v1/ai/coach/${id}`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate; return route.fulfill({ status: 503, json: { error: 'Synthetic generation outage' } });
  });
  await composer(page).press(`${MOD}+Enter`); await expect(composer(page)).toHaveValue('');
  await composer(page).fill('Complete newer draft 日本語'); await expect(composer(page)).toBeEnabled();
  await composer(page).press(`${MOD}+Enter`); await expect(composer(page)).toHaveValue('Complete newer draft 日本語'); release();
  const earlier = page.getByRole('region', { name: 'Unsent response' });
  await expect(earlier).toBeVisible({ timeout: 20000 }); await attach('newer');
  await expect(page.getByRole('button', { name: 'Move to draft', exact: true })).toBeDisabled();
  await page.reload(); await expect(earlier).toContainText('Earlier full submission'); await expect(earlier.getByRole('img')).toHaveCount(4);
  await expect(composer(page)).toHaveValue('Complete newer draft 日本語');
  const journals = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => /plato_lesson_(submission|draft)/.test(key)).map(([, v]) => JSON.parse(v)));
  const drafts = journals.map(j => j.draft || j);
  expect(drafts.some(d => d.text === 'Earlier full submission' && d.images.length === 4 && d.links.length === 3)).toBe(true);
  expect(drafts.some(d => d.text === 'Complete newer draft 日本語' && d.images.length === 4 && d.links.length === 3)).toBe(true);
});

test('dedicated coaching rejects max_tokens and keeps submitted work separate from a newer draft', async ({ page, request }) => {
  const id = LESSONS[2].id, headers = await reset(request, id);
  await open(page, id);
  const before = await (await request.get(`/v1/sync/lesson-turn/${id}`, { headers })).json();
  await composer(page).fill('MOCK_SLOW MOCK_TRUNCATE full original learner submission');
  await composer(page).press(`${MOD}+Enter`);
  await expect(composer(page)).toHaveValue('');
  await composer(page).fill('Newer draft must survive');
  await expect(page.getByRole('region', { name: 'Unsent response' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('region', { name: 'Unsent response' })).toContainText('full original learner submission');
  await expect(page.getByRole('alert').filter({ hasText: /cut off/ })).toBeVisible();
  await expect(composer(page)).toHaveValue('Newer draft must survive');
  const after = await (await request.get(`/v1/sync/lesson-turn/${id}`, { headers })).json();
  expect(after).toEqual(before);
});
