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
const evidence = browserEvidence('notification-audience');
let server, browser, base;

// Render the real page and UI components; only authentication and HTTP are
// synthetic. No persistent server/database or external delivery is involved.
async function open(t) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
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
    if (path === '/v1/admin/notifications/messages') return reply({ messages: [] });
    if (path === '/v1/admin/notifications') return reply({ settings: {}, templates: [] });
    if (path === '/v1/admin/users') return reply([]);
    if (path === '/v1/groups') return reply({ userGroups: ['Two-person group'] });
    throw new Error(`Unexpected fixture request: ${request.method()} ${path}`);
  });
  await page.goto(`${base}/__audience-review`);
  await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
  await page.getByRole('status').filter({ hasText: 'Goes to 10 people.' }).waitFor();
  await page.getByLabel('Subject', { exact: true }).fill('Reviewed message');
  await page.getByLabel('Message', { exact: true }).fill('Synthetic classroom message.');
  t.after(async () => {
    assert.deepEqual(errors, [], 'no unhandled browser errors');
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    await writeFile(join(evidence, `${t.name.replace(/\W+/g, '-')}.txt`), await page.locator('body').ariaSnapshot());
    await context.close();
  });
  return {
    page, sent,
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
          if (id === '\0audience-review') return `import React from 'react'; import {createRoot} from 'react-dom/client'; import AdminNotifications from '${root}/client/src/pages/admin/AdminNotifications.jsx'; import '${root}/client/src/index.css'; createRoot(document.getElementById('root')).render(React.createElement(AdminNotifications));`;
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
    await f.page.getByRole('status').filter({ hasText: 'Could not preview this audience.' }).waitFor();
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
});
