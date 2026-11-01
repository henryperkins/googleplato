/**
 * Invitation-only Google sign-in on the real sign-in page. Only Google is
 * substituted: the lazily loaded Firebase chunk (the popup) and the server's
 * answer to the verified token, which the test server can't verify.
 */
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
const evidence = join(root, 'output/playwright/invite-required', browserName === 'chromium' ? '' : browserName);
const GOOGLE_STUB = `
export const app = {};
export const auth = {};
export function onAuthStateChanged() { return () => {}; }
export async function signInWithGooglePopup() { return { firebaseUser: {}, idToken: 'stub-google-token' }; }
export async function signOutFirebase() {}
`;
let browser;
let server;
let directory;
let base;

async function signInWithGoogle({ reply, waitlistOpen = true, width = 390, height = 844, theme = 'light' }) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(value => localStorage.setItem('plato_theme', value), theme);
  await context.route('**/assets/firebaseAuth-*.js', route => route.fulfill({ contentType: 'text/javascript', body: GOOGLE_STUB }));
  await context.route('**/v1/auth/firebase', route => route.fulfill(reply));
  await context.route('**/v1/waitlist', route => (route.request().method() === 'GET'
    ? route.fulfill({ json: { open: waitlistOpen } })
    : route.fallback()));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${base}/login`);
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  return { context, page };
}

const inviteRequired = admission => ({
  status: 403,
  json: { error: 'Membership is by invitation only. Ask your program admin for an invitation.', code: 'invite_required', ...admission },
});
const focusedText = page => page.evaluate(() => document.activeElement?.textContent?.trim());

describe('Invitation-only Google sign-in', { timeout: 90000 }, () => {
  before(async () => {
    await mkdir(evidence, { recursive: true });
    directory = await mkdtemp(join(tmpdir(), 'plato-invite-required-'));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['dev-sqlite.js'], {
      cwd: join(root, 'server'),
      env: { ...process.env, PORT: String(port), SQLITE_PATH: join(directory, 'test.sqlite'), APP_URL: base,
        JWT_SECRET: randomBytes(32).toString('hex'), ADMIN_EMAIL: 'operator@plato.test',
        ADMIN_PASSWORD: randomBytes(24).toString('base64url'), SKIP_EMAIL: 'true' },
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

  it("replaces the form, takes focus, and offers the wait list with Google's details", async () => {
    const { context, page } = await signInWithGoogle({
      reply: inviteRequired({ email: 'new.learner@example.test', name: 'New Learner', waitlisted: false, inviteExpired: false }),
    });
    try {
      const heading = page.getByRole('heading', { level: 1, name: 'Membership is by invitation only' });
      await heading.waitFor();
      assert.equal(await focusedText(page), 'Membership is by invitation only');
      assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
      assert.match(await page.title(), /^Invitation required — /);
      await page.getByText(/^Thank you for your interest in joining .+\.$/).waitFor();
      await page.getByText("There's no account for new.learner@example.test.", { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Password', { exact: true }).count(), 0, 'the sign-in form is gone');
      await page.screenshot({ path: join(evidence, 'mobile-light-join.png'), fullPage: true });
      await page.keyboard.press('Tab');
      assert.equal(await focusedText(page), 'Join the wait list');
      await page.keyboard.press('Enter');
      await page.waitForURL(`${base}/waitlist`);
      await page.getByRole('heading', { name: 'Join the wait list', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'New Learner');
      assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'new.learner@example.test');
    } finally { await context.close(); }
  });

  it('tells a wait-listed person they are on the list, then returns focus to sign in', async () => {
    const { context, page } = await signInWithGoogle({
      reply: inviteRequired({ email: 'waiting@example.test', name: 'Waiting Person', waitlisted: true, inviteExpired: false }),
    });
    try {
      await page.getByText("You're on the wait list. We'll email you when you're invited.", { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Join the wait list' }).count(), 0);
      await page.screenshot({ path: join(evidence, 'mobile-light-waitlisted.png'), fullPage: true });
      await page.keyboard.press('Tab');
      assert.equal(await focusedText(page), 'Back to sign in');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      assert.equal(await focusedText(page), 'Sign in');
      assert.match(await page.title(), /^Sign in — /);
      await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
    } finally { await context.close(); }
  });

  it('explains an expired invitation, without a wait list when it is closed', async () => {
    const { context, page } = await signInWithGoogle({
      waitlistOpen: false,
      reply: inviteRequired({ email: 'late@example.test', name: '', waitlisted: false, inviteExpired: true }),
    });
    try {
      await page.getByText('Your invitation has expired. Ask your program admin to send a new one.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Join the wait list' }).count(), 0);
      await page.getByRole('button', { name: 'Back to sign in' }).waitFor();
    } finally { await context.close(); }
  });

  it('points to an admin when the wait list is closed', async () => {
    const { context, page } = await signInWithGoogle({
      waitlistOpen: false, width: 1280, height: 900, theme: 'dark',
      reply: inviteRequired({ email: 'someone.with.a.long.address@department.example.test', name: '', waitlisted: false, inviteExpired: false }),
    });
    try {
      await page.getByText(/Otherwise, ask your program admin for an invitation\.$/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Join the wait list' }).count(), 0);
      await page.screenshot({ path: join(evidence, 'desktop-dark-closed.png'), fullPage: true });
    } finally { await context.close(); }
  });

  it('keeps other Google sign-in failures on the form', async () => {
    const { context, page } = await signInWithGoogle({
      reply: { status: 400, json: { error: 'This invite is for a different email address' } },
    });
    try {
      await page.getByRole('alert').filter({ hasText: 'This invite is for a different email address' }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Membership is by invitation only' }).count(), 0);
      await page.getByLabel('Password', { exact: true }).waitFor();
    } finally { await context.close(); }
  });
});
