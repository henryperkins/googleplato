import { browserEvidence } from './evidence.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
// One automation's email as GET /v1/admin/notifications returns it, plus the
// default the fixture restores on DELETE.
const waitlistEmail = (overrides = {}) => {
  const defaults = { subject: 'You’re on the wait list', body: 'Thanks for joining.' };
  return { id: 'waitlist-confirmation', label: 'Wait list confirmation', description: 'Sent once, when someone joins the wait list.',
    variables: ['firstName', 'classroomName'], isDefault: true, updatedAt: null, ...defaults, defaults, ...overrides };
};
const failedMessage = (overrides = {}) => ({ id: 'msg_failed123', subject: 'Earlier update', body: 'News', email: true, inApp: true,
  createdAt: '2026-11-01T00:00:00.000Z', createdByName: 'Synthetic Admin', audience: { type: 'all', allRoles: true }, status: 'failed',
  counts: { recipients: 3, emailed: 1, failed: 2 }, ...overrides });
const longFailure = () => failedMessage({ id: 'msg_long123', important: true,
  subject: 'Capstone deadline moved to Friday — please re-read the exemplar before submitting your final artifact',
  audience: { type: 'role', roles: ['learner', 'educator'], allRoles: true },
  counts: { recipients: 214, emailed: 180, optedOut: 12, blocked: 3, failed: 19 },
  deliveryError: 'The email service rejected 19 messages (451 temporary failure).' });
const evidence = browserEvidence('notification-audience');
let server, browser, base;

// Render the real page and UI components; only authentication and HTTP are
// synthetic. No persistent server/database or external delivery is involved.
async function open(t, { history = [], templates = [], automations = {}, groups = ['Two-person group'], automationFailures = 0, settingsFailures = 0, draft = true, viewport = { width: 1280, height: 1100 } } = {}) {
  const ready = settingsFailures === 0;
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  // Cold Vite dependency optimization in Cloud Build can exceed eight seconds
  // before the first fixture navigation completes; behavioral waits stay bounded.
  page.setDefaultTimeout(30000);
  const errors = [], sent = [], pending = [], waiters = [];
  let held = false;
  let holdSend = false;
  const sendPending = [], sendWaiters = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(() => localStorage.setItem('plato_auth', JSON.stringify({
    accessToken: 'local-only', refreshToken: 'local-only-r', user: { userId: 'synthetic-admin', role: 'admin' },
  })));
  await page.route('**/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const reply = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/v1/admin/notifications/preview') {
      const audience = request.postDataJSON().audience;
      if (held) {
        const preview = {
          audience,
          succeed: async count => {
            await reply({ count, emailOptedOut: 0 });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          },
          fail: () => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Controlled preview failure"}' }),
        };
        if (waiters.length) waiters.shift()(preview);
        else pending.push(preview);
        return;
      }
      return reply({ count: audience.type === 'group' ? 2 : audience.type === 'role' ? 4 : 10 });
    }
    if (path === '/v1/admin/notifications/messages' && request.method() === 'POST') {
      sent.push(request.postDataJSON());
      if (holdSend) {
        const release = () => reply({ message: { status: 'sent' } });
        if (sendWaiters.length) sendWaiters.shift()(release); else sendPending.push(release);
        return;
      }
      return reply({ message: { status: 'sent' } });
    }
    if (path === '/v1/admin/notifications/messages') return reply({ messages: history });
    if (path.endsWith('/retry') && request.method() === 'POST') {
      const message = history.find(message => path.endsWith(`/${message.id}/retry`));
      message.status = 'sent'; message.deliveryError = null;
      return reply({ message });
    }
    if (path.startsWith('/v1/admin/notifications/templates/')) {
      const template = templates.find(template => path.endsWith(`/${template.id}`));
      if (!template) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Template not found"}' });
      if (request.method() === 'PUT') Object.assign(template, request.postDataJSON(), { isDefault: false, updatedAt: new Date().toISOString() });
      if (request.method() === 'DELETE') Object.assign(template, template.defaults, { isDefault: true, updatedAt: null });
      return reply({ template: { ...template } });
    }
    if (path === '/v1/admin/notifications/automations' && request.method() === 'PUT') {
      if (automationFailures-- > 0) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Controlled automation failure"}' });
      Object.assign(automations, request.postDataJSON());
      return reply({ automations: { ...automations } });
    }
    if (path.endsWith('/close') && request.method() === 'POST') {
      const message = history.find(message => path.endsWith(`/${message.id}/close`));
      message.status = 'closed'; message.deliveryError = null;
      return reply({ message });
    }
    if (path === '/v1/admin/notifications') {
      if (settingsFailures-- > 0) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Controlled settings failure"}' });
      return reply({ automations: { ...automations }, alwaysOn: [], templates: templates.map(template => ({ ...template })) });
    }
    if (path === '/v1/admin/users') return reply([]);
    if (path === '/v1/groups') return reply({ userGroups: groups });
    throw new Error(`Unexpected fixture request: ${request.method()} ${path}`);
  });
  await page.goto(`${base}/__audience-review`);
  await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
  if (ready) await page.getByRole('status').filter({ hasText: 'Goes to 10 people.' }).waitFor();
  if (draft && ready) {
    await page.getByLabel('Subject', { exact: true }).fill('Reviewed message');
    await page.getByLabel('Message', { exact: true }).fill('Synthetic classroom message.');
  }
  t.after(async () => {
    assert.deepEqual(errors, [], 'no unhandled browser errors');
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    await writeFile(join(evidence, `${t.name.replace(/\W+/g, '-')}.txt`), await page.locator('body').ariaSnapshot());
    await context.close();
  });
  return {
    page, sent,
    // The page under test sits in a data router, as in the app, so its
    // leave guard can hold a navigation.
    navigate(path) { return page.evaluate(to => { window.__router.navigate(to); }, path); },
    focused() { return page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''); },
    holdSend() { holdSend = true; },
    nextSend() { return sendPending.length ? Promise.resolve(sendPending.shift()) : new Promise(resolve => sendWaiters.push(resolve)); },
    send: page.getByRole('button', { name: 'Send', exact: true }),
    hold() { held = true; },
    nextPreview() { return pending.length ? Promise.resolve(pending.shift()) : new Promise(resolve => waiters.push(resolve)); },
    async group() {
      await page.getByRole('radio', { name: 'A group', exact: true }).check();
      await page.getByLabel('Group', { exact: true }).selectOption('Two-person group');
    },
  };
}

describe('notification audience preview and confirmation', { timeout: 120000 }, () => {
  before(async () => {
    server = await createServer({
      configFile: join(root, 'client/vite.config.js'), root: join(root, 'client'),
      cacheDir: join(evidence, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, fs: { allow: [root, realpathSync(join(root, 'node_modules'))] } },
      plugins: [{
        name: 'notification-audience-test', enforce: 'pre',
        resolveId(id) { if (id === '/__audience-entry.jsx') return '\0audience-review'; },
        load(id) {
          if (id === '\0audience-review') return `import React from 'react'; import {createRoot} from 'react-dom/client'; import {createMemoryRouter, RouterProvider} from 'react-router-dom'; import AdminNotifications from '${root}/client/src/pages/admin/AdminNotifications.jsx'; import '${root}/client/src/index.css'; const router = createMemoryRouter([{ path: '/plato/notifications', element: React.createElement(AdminNotifications) }, { path: '/plato', element: React.createElement('h1', null, 'Dashboard') }], { initialEntries: ['/plato/notifications'] }); window.__router = router; createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));`;
          if (id === join(root, 'client/src/contexts/AuthContext.jsx')) return "export const useAuth=()=>({user:{userId:'synthetic-admin',role:'admin'}});";
        },
        configureServer(vite) {
          vite.middlewares.use('/__audience-review', async (_request, response) => {
            const html = await vite.transformIndexHtml('/__audience-review', '<!doctype html><html><head><title>Notification audience review</title></head><body style="max-width:920px;margin:24px auto;padding:12px"><div id="root"></div><script type="module" src="/__audience-entry.jsx"></script></body></html>');
            response.setHeader('Content-Type', 'text/html'); response.end(html);
          });
        },
      }],
    });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch();
  });
  after(async () => { await browser?.close(); await server?.close(); });

  it('stops retrying a failed message from History and retains its delivery outcomes', async t => {
    const f = await open(t, { history: [{ id: 'msg_history123', subject: 'Earlier update', body: 'News', email: true, inApp: true,
      createdAt: '2026-11-01T00:00:00.000Z', audience: { type: 'all', allRoles: true }, status: 'failed',
      counts: { recipients: 3, emailed: 1, failed: 2, pending: 1 } }] });
    await f.page.getByRole('tab', { name: 'History', exact: true }).click();
    const row = f.page.getByRole('row').filter({ hasText: 'Earlier update' });
    await row.getByRole('button', { name: 'Stop retrying', exact: true }).click();
    const confirmation = f.page.getByRole('alertdialog');
    await confirmation.getByRole('heading', { name: 'Stop retrying this message?', exact: true }).waitFor();
    await confirmation.getByRole('button', { name: 'Stop retrying', exact: true }).click();
    await row.getByText('Retries stopped', { exact: true }).waitFor();
    assert.equal(await row.getByRole('button', { name: 'Retry delivery', exact: true }).count(), 0);
    assert.equal(await row.getByRole('button', { name: 'Stop retrying', exact: true }).count(), 0);
    assert.match(await row.innerText(), /1 emailed.*2 failed.*1 pending confirmation/);
    assert.equal(await f.page.getByRole('tab', { name: 'History', selected: true }).count(), 1);
    await f.page.screenshot({ path: join(evidence, 'closed-message-history.png'), fullPage: true });
  });

  it('keeps a newer draft and its focus when an earlier send completes', async t => {
    const f = await open(t);
    f.holdSend();
    await f.send.click();
    await f.page.getByRole('alertdialog').getByRole('button', { name: 'Send', exact: true }).click();
    const release = await f.nextSend();
    const sending = f.page.getByRole('button', { name: 'Sending…', exact: true });
    assert.equal(await sending.getAttribute('aria-disabled'), 'true');
    await sending.focus();
    assert.equal(await sending.evaluate(element => document.activeElement === element), true);
    await f.page.getByLabel('Subject', { exact: true }).fill('Second subject');
    const field = f.page.getByLabel('Message', { exact: true });
    await field.fill('Second exact body\nwith another line.');
    release();
    await f.page.getByRole('status').filter({ hasText: '“Reviewed message” was sent. Your newer draft is kept.' }).waitFor();
    assert.equal(await f.page.getByLabel('Subject', { exact: true }).inputValue(), 'Second subject');
    assert.equal(await field.inputValue(), 'Second exact body\nwith another line.');
    assert.equal(await field.evaluate(element => document.activeElement === element), true);
    assert.equal(await f.page.getByRole('tab', { name: 'Compose', selected: true }).count(), 1);
    assert.deepEqual(f.sent[0], { subject: 'Reviewed message', body: 'Synthetic classroom message.', inApp: true, email: false, important: false, audience: { type: 'all' }, requestId: f.sent[0].requestId });
    await f.send.click();
    await f.page.getByRole('alertdialog').getByRole('button', { name: 'Send', exact: true }).click();
    const releaseSecond = await f.nextSend();
    assert.notEqual(f.sent[1].requestId, f.sent[0].requestId);
    assert.equal(f.sent[1].subject, 'Second subject');
    assert.equal(f.sent[1].body, 'Second exact body\nwith another line.');
    releaseSecond();
    await f.page.getByRole('tab', { name: 'History', selected: true }).waitFor();
  });

  it('requires the new Everyone preview before confirming the reviewed count and audience', async t => {
    const f = await open(t);
    await f.group();
    await f.page.getByRole('status').filter({ hasText: 'Goes to 2 people.' }).waitFor();
    f.hold();
    await f.page.getByRole('radio', { name: 'Everyone', exact: true }).check();
    assert.equal(await f.send.isDisabled(), true, 'Send is disabled immediately, before the debounce fires');
    assert.equal(await f.page.getByRole('status').filter({ hasText: 'Goes to 2 people.' }).count(), 0);
    const everyone = await f.nextPreview();
    assert.deepEqual(everyone.audience, { type: 'all' });
    assert.equal(await f.send.isDisabled(), true, 'Send stays disabled while the current preview is pending');
    await everyone.succeed(10);
    await f.page.getByRole('status').filter({ hasText: 'Goes to 10 people.' }).waitFor();
    await f.send.click();
    const confirmation = f.page.getByRole('alertdialog');
    await confirmation.getByRole('heading', { name: 'Send to 10 people?', exact: true }).waitFor();
    await f.page.screenshot({ path: join(evidence, 'audience-current-confirmation.png'), fullPage: true });
    await confirmation.getByRole('button', { name: 'Send', exact: true }).click();
    await f.page.getByRole('tab', { name: 'History', selected: true }).waitFor();
    assert.equal(await f.focused(), 'History', 'the History tab takes focus from the hidden Send button');
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].audience, { type: 'all' });
    assert.equal(f.sent[0].subject, 'Reviewed message');
  });

  it('ignores both earlier and later resolution of obsolete role previews', async t => {
    const f = await open(t);
    f.hold();
    await f.page.getByRole('radio', { name: 'By role', exact: true }).check();
    await f.page.getByRole('checkbox', { name: 'Learners', exact: true }).check();
    const role = await f.nextPreview();
    await f.page.getByRole('radio', { name: 'Everyone', exact: true }).check();
    const everyone = await f.nextPreview();
    await role.succeed(4);
    assert.equal(await f.send.isDisabled(), true, 'an obsolete response cannot unlock pending Everyone');
    await everyone.succeed(10);
    await f.page.getByRole('status').filter({ hasText: 'Goes to 10 people.' }).waitFor();
    await f.page.getByRole('radio', { name: 'By role', exact: true }).check();
    const laterRole = await f.nextPreview();
    await f.group();
    const group = await f.nextPreview();
    await group.succeed(2);
    await f.page.getByRole('status').filter({ hasText: 'Goes to 2 people.' }).waitFor();
    await laterRole.succeed(4);
    await f.page.getByRole('radio', { name: 'A group', exact: true }).waitFor();
    assert.equal(await f.page.getByRole('status').filter({ hasText: 'Goes to 2 people.' }).isVisible(), true);
    assert.deepEqual(f.sent, []);
  });

  it('keeps Send disabled for failed, repeated, and empty audience previews', async t => {
    const f = await open(t);
    f.hold();
    await f.group();
    const group = await f.nextPreview();
    assert.equal(await f.send.isDisabled(), true, 'previous Everyone count cannot authorize a group send');
    await group.fail();
    await f.page.getByRole('status').filter({ hasText: 'Couldn’t count this audience. Choose it again to retry.' }).waitFor();
    assert.equal(await f.send.isDisabled(), true);
    assert.equal(await f.page.getByRole('status').filter({ hasText: 'Goes to 10 people.' }).count(), 0);
    assert.equal(await f.page.getByRole('alertdialog').count(), 0);
    assert.deepEqual(f.sent, []);
    // Returning to the same serialized audience must await a new response,
    // rather than reusing the success from before the intervening edit.
    await f.page.getByRole('radio', { name: 'Everyone', exact: true }).check();
    assert.equal(await f.send.isDisabled(), true);
    const everyone = await f.nextPreview();
    await everyone.succeed(0);
    await f.page.getByRole('status').filter({ hasText: 'Goes to 0 people.' }).waitFor();
    assert.equal(await f.send.isDisabled(), true);
  });

  it('invalidates an open confirmation when the reviewed audience or message changes', async t => {
    const f = await open(t);
    await f.send.click();
    await f.page.getByRole('alertdialog').waitFor();
    // Simulate a draft state change while the dialog is open. Pointer access is
    // intentionally blocked by the real modal, but programmatic/async changes
    // must also invalidate the reviewed snapshot.
    await f.page.getByRole('radio', { name: 'A group', exact: true }).evaluate(element => element.click());
    await f.page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    assert.deepEqual(f.sent, []);
    await f.page.getByLabel('Group', { exact: true }).selectOption('Two-person group');
    await f.page.getByRole('status').filter({ hasText: 'Goes to 2 people.' }).waitFor();
    await f.send.click();
    const confirmation = f.page.getByRole('alertdialog');
    await confirmation.getByRole('heading', { name: 'Send to 2 people?', exact: true }).waitFor();
    await f.page.getByLabel('Subject', { exact: true }).evaluate(element => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, 'Changed after review');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await confirmation.waitFor({ state: 'hidden' });
    assert.deepEqual(f.sent, []);
  });

  it('keeps unsaved email edits across tabs and asks before leaving the page', async t => {
    const f = await open(t, { templates: [waitlistEmail()], automations: { waitlistConfirmation: false }, draft: false });
    await f.page.getByRole('tab', { name: 'Automations', exact: true }).click();
    const panel = f.page.getByRole('tabpanel');
    await panel.getByRole('heading', { name: 'Wait list confirmation', level: 2 }).waitFor();
    await panel.locator('summary').click();
    await panel.getByLabel('Subject', { exact: true }).fill('Thanks, {{firstName}}');
    await panel.getByRole('status').filter({ hasText: 'Unsaved changes' }).waitFor();
    await f.page.getByRole('tab', { name: 'History', exact: true }).click();
    await f.page.getByRole('tab', { name: 'Automations', exact: true }).click();
    assert.equal(await panel.getByLabel('Subject', { exact: true }).inputValue(), 'Thanks, {{firstName}}', 'the draft outlives the tab');
    await f.navigate('/plato');
    const leave = f.page.getByRole('alertdialog');
    await leave.getByRole('heading', { name: 'Leave without saving?', exact: true }).waitFor();
    assert.match(await leave.innerText(), /Your changes to “Wait list confirmation” haven’t been saved/);
    await leave.getByRole('button', { name: 'Stay here', exact: true }).click();
    await leave.waitFor({ state: 'hidden' });
    const save = panel.getByRole('button', { name: 'Save', exact: true });
    await save.focus();
    await f.page.keyboard.press('Enter');
    await panel.getByRole('status').filter({ hasText: 'Email saved.' }).waitFor();
    assert.equal(await save.evaluate(element => document.activeElement === element), true, 'Save keeps focus');
    await f.navigate('/plato');
    await f.page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
  });

  it('moves focus to what remains after Use the default or a retry that settles the message', async t => {
    const f = await open(t, { templates: [waitlistEmail({ subject: 'Custom subject', isDefault: false, updatedAt: '2026-11-01T00:00:00.000Z' })],
      history: [failedMessage()], draft: false });
    await f.page.getByRole('tab', { name: 'Automations', exact: true }).click();
    const panel = f.page.getByRole('tabpanel');
    await panel.locator('summary').click();
    await panel.getByRole('button', { name: 'Use the default', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    await panel.getByRole('status').filter({ hasText: 'Back to plato’s default email.' }).waitFor();
    assert.equal(await f.focused(), 'Send a test to me');
    assert.equal(await panel.getByLabel('Subject', { exact: true }).inputValue(), 'You’re on the wait list');
    await f.page.getByRole('tab', { name: 'History', exact: true }).click();
    await f.page.getByRole('button', { name: 'Retry delivery', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    await f.page.getByRole('row').filter({ hasText: 'Earlier update' }).getByText('Processed', { exact: true }).waitFor();
    assert.equal(await f.focused(), 'Processed', 'the new status takes focus from the removed actions');
  });

  it('fits History beside long subjects, with Status and its actions in view', async t => {
    const f = await open(t, { history: [longFailure()], draft: false });
    await f.page.getByRole('tab', { name: 'History', exact: true }).click();
    const region = f.page.getByRole('region', { name: 'Sent messages' });
    await region.getByRole('cell', { name: /Delivery failed/ }).waitFor();
    assert.equal(await region.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'the table needs no sideways scroll');
    const [retry, frame] = await Promise.all([region.getByRole('button', { name: 'Retry delivery', exact: true }).boundingBox(), region.boundingBox()]);
    assert.ok(retry.x + retry.width <= frame.x + frame.width, 'Retry delivery is inside the table frame');
    await f.page.screenshot({ path: join(evidence, 'history-desktop.png'), fullPage: true });
  });

  it('lists History on a phone, with a failed delivery and its actions in view', async t => {
    const f = await open(t, { history: [longFailure()], draft: false, viewport: { width: 390, height: 844 } });
    await f.page.getByRole('tab', { name: 'History', exact: true }).click();
    const list = f.page.getByRole('list', { name: 'Sent messages' });
    await list.getByText('Delivery failed', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('table').count(), 0);
    const retry = await list.getByRole('button', { name: 'Retry delivery', exact: true }).boundingBox();
    assert.ok(retry.x >= 0 && retry.x + retry.width <= 390, 'Retry delivery is on screen');
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    await f.page.screenshot({ path: join(evidence, 'history-phone.png'), fullPage: true });
  });

  it('offers Try again when Notifications can’t load, then focuses the page heading', async t => {
    const f = await open(t, { settingsFailures: 1 });
    const alert = f.page.getByRole('alert').filter({ hasText: 'Notifications could not be loaded.' });
    await alert.waitFor();
    await alert.getByRole('button', { name: 'Try again', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    await f.page.getByRole('tab', { name: 'Compose', exact: true }).waitFor();
    assert.equal(await f.focused(), 'Notifications');
  });

  it('says why Send is off, and why a group can’t be chosen', async t => {
    const f = await open(t, { draft: false, groups: [] });
    const reason = async () => f.page.locator(`#${await f.send.getAttribute('aria-describedby')}`).textContent();
    assert.equal(await reason(), 'Add a subject and a message.');
    await f.page.getByLabel('Subject', { exact: true }).fill('Reviewed message');
    assert.equal(await reason(), 'Add a message.');
    await f.page.getByRole('radio', { name: 'By role', exact: true }).check();
    assert.equal(await reason(), 'Choose at least one role.');
    const group = f.page.getByRole('radio', { name: 'A group', exact: true });
    assert.equal(await group.isDisabled(), true);
    assert.equal(await group.evaluate(radio => document.getElementById(radio.getAttribute('aria-describedby'))?.textContent),
      'No groups yet. Add one under Users → Manage → User Groups.');
    await f.page.getByRole('radio', { name: 'Everyone', exact: true }).check();
    await f.page.getByLabel('Message', { exact: true }).fill('Synthetic classroom message.');
    await f.page.getByRole('status').filter({ hasText: 'Goes to 10 people.' }).waitFor();
    assert.equal(await f.send.getAttribute('aria-describedby'), null, 'a ready message needs no reason');
  });

  it('turns an automatic email on with a switch, and says when the change didn’t save', async t => {
    const f = await open(t, { templates: [waitlistEmail()], automations: { waitlistConfirmation: false }, automationFailures: 1, draft: false });
    await f.page.getByRole('tab', { name: 'Automations', exact: true }).click();
    const panel = f.page.getByRole('tabpanel');
    const toggle = panel.getByRole('switch', { name: 'Wait list confirmation email', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await panel.getByText(/^Wait list confirmation is still off\. Controlled automation failure\.$/).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'the switch goes back');
    assert.equal(await toggle.evaluate(element => document.activeElement === element), true, 'the switch keeps focus');
    await toggle.click();
    await panel.getByText('On', { exact: true }).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.equal(await panel.getByText(/is still off/).count(), 0, 'the earlier failure clears');
  });
});
