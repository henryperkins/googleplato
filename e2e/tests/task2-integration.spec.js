import { test, expect } from '@playwright/test';
import { login, expectAccessible } from '../helpers.js';
import { ADMIN, LEARNER } from '../fixtures.js';

function pending() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), release: () => resolve() };
}
const entry = (token, firstName, lastName) => ({ inviteToken: token, firstName, lastName, name: `${firstName} ${lastName}`,
  nameSource: 'explicit', email: `${firstName.toLowerCase()}@example.test`, createdAt: '2026-11-01T12:00:00Z', alreadyRegistered: 'account', customFields: {} });

for (const width of [1280, 390]) {
  test(`existing-account invite is submitted once and cannot close a newer editor at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let entries = [entry('first-entry', 'Zoe', 'West'), entry('second-entry', 'Yuki', 'East')];
    await page.route('**/v1/admin/waitlist', route => route.fulfill({ json: { entries, open: true, hasApiKey: false } }));
    const delivery = pending();
    let calls = 0;
    await page.route('**/v1/admin/waitlist/first-entry/invite', async route => {
      calls++;
      await delivery.promise;
      entries = entries.filter(item => item.inviteToken !== 'first-entry');
      await route.fulfill({ status: 201, json: { existingAccount: true, emailDelivery: 'off', signupUrl: '/lessons' } });
    });
    await login(page, ADMIN);
    await page.goto('/plato/users');
    await page.getByRole('button', { name: 'Edit wait list entry for Zoe West' }).click();
    const invite = page.getByRole('button', { name: 'Invite', exact: true });
    await invite.evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => calls).toBe(1);
    await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'Remove from wait list' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('First name')).toBeDisabled();
    await expect(page.getByText('Copy to account', { exact: true })).toHaveCount(0);
    await page.goBack();
    await page.getByRole('button', { name: 'Edit wait list entry for Yuki East' }).click();
    delivery.release();
    await expect(page).toHaveURL(/\/plato\/users\/waitlist\/second-entry$/);
    await expect(page.getByLabel('First name')).toHaveValue('Yuki');
    await expect.poll(() => calls).toBe(1);
    await expectAccessible(page, { label: `waitlist editor ${width}` });
    await page.screenshot({ path: `test-results/task2-waitlist-${width}.png`, fullPage: true });
  });
}

test('wait-list conflicts retain edited names and keep Invite disabled until the edit is saved', async ({ page }) => {
  const saved = entry('edit-entry', 'Zoe', 'West');
  const delivery = pending();
  let writes = 0;
  await page.route('**/v1/admin/waitlist', route => route.fulfill({ json: { entries: [saved], open: true } }));
  await page.route('**/v1/admin/waitlist/edit-entry', async route => {
    writes++;
    expect(route.request().postDataJSON().lastName).toBe('Updated');
    await delivery.promise;
    await route.fulfill({ status: 409, json: { error: 'This entry changed. Review your saved answers and try again.' } });
  });
  await login(page, ADMIN);
  await page.goto('/plato/users/waitlist/edit-entry');
  await page.getByLabel(/^Last name/).fill('Updated');
  await expect(page.getByRole('button', { name: 'Invite', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Save', exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => writes).toBe(1);
  delivery.release();
  await expect(page.getByRole('alert')).toContainText('This entry changed');
  await expect(page.getByLabel(/^Last name/)).toHaveValue('Updated');
  await expect(page).toHaveURL(/\/edit-entry$/);
  await expect(page.getByRole('button', { name: 'Invite', exact: true })).toHaveAttribute('aria-disabled', 'true');
});

test('failed message sends retain the draft and request ID; History retries without claiming disabled email was sent', async ({ page }) => {
  let message = null;
  const requestIds = [];
  await page.route('**/v1/admin/notifications/messages', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { messages: message ? [message] : [] } });
    const body = route.request().postDataJSON();
    requestIds.push(body.requestId);
    message = { ...body, id: 'failed-message', status: 'failed', createdAt: new Date().toISOString(), createdByName: 'Admin',
      deliveryError: 'Email delivery failed. Retry this message.', counts: { recipients: 2, failed: 2 } };
    await route.fulfill({ status: 503, json: { error: 'Dispatch failed', message } });
  });
  await page.route('**/v1/admin/notifications/messages/failed-message/retry', route => {
    message = { ...message, status: 'sent', deliveryError: null, counts: { recipients: 2, skipped: 2, emailed: 0 } };
    return route.fulfill({ json: { message } });
  });
  await login(page, ADMIN);
  await page.goto('/plato/notifications');
  await page.getByLabel('Subject', { exact: true }).fill('Retained message');
  await page.getByLabel('Message', { exact: true }).fill('Keep the same message on retry.');
  await page.getByLabel('By email', { exact: true }).check();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      await page.getByRole('tab', { name: 'History' }).click();
      await page.getByRole('tab', { name: 'Compose' }).click();
      await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Retained message');
    }
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Dispatch failed.*Your draft is retained/).first()).toBeVisible();
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Retained message');
  }
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  await page.getByRole('tab', { name: 'History' }).click();
  const history = page.getByRole('region', { name: 'Sent messages' });
  await expect(history).toContainText('Delivery failed');
  await history.getByRole('button', { name: 'Retry delivery' }).click();
  await expect(history).toContainText('2 not sent (email delivery disabled)');
  await expect(history).not.toContainText('Delivery failed');
  await expectAccessible(page, { label: 'retry history' });
});

test('keyboard opening the bell acknowledges the displayed unread messages', async ({ page, request }) => {
  const authResponse = await request.post('/v1/auth/login', { data: ADMIN });
  const { accessToken } = await authResponse.json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const users = await (await request.get('/v1/admin/users', { headers })).json();
  const learner = users.find(user => user.email === LEARNER.email);
  await request.post('/v1/admin/notifications/messages', { headers,
    data: { subject: 'Keyboard acknowledgement', body: 'Read from the bell.', inApp: true, audience: { type: 'users', userIds: [learner.userId] } } });
  await login(page, LEARNER);
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName(/unread/);
  const marked = page.waitForResponse(response => response.url().endsWith('/v1/me/messages/read') && response.ok());
  await bell.focus();
  await page.keyboard.press('ArrowDown');
  await marked;
  await expect(page.getByRole('menuitem', { name: /Keyboard acknowledgement/ })).toBeVisible();
  await expect(bell).toHaveAccessibleName('Notifications');
  await page.keyboard.press('Escape');
  await expect(bell).toBeFocused();
});


test('important messages remain one at a time across a visibility refresh', async ({ page }) => {
  const messages = ['Newest', 'Older'].map((subject, i) => ({ id: `popup-${i}`, subject, body: 'Read and acknowledge this message.', important: true, read: false, createdAt: new Date().toISOString() }));
  await page.route('**/v1/me/messages', route => route.fulfill({ json: { messages } }));
  await page.route('**/v1/me/messages/read', route => {
    const { ids } = route.request().postDataJSON();
    for (const message of messages) if (ids.includes(message.id)) message.read = true;
    return route.fulfill({ json: { ok: true } });
  });
  await login(page, LEARNER);
  await expect(page.getByRole('dialog', { name: 'Newest', exact: true })).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('dialog', { name: 'Newest', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: 'Newest', exact: true }).getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByRole('dialog', { name: 'Older', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: 'Older', exact: true }).getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
