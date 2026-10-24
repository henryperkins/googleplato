/**
 * When a session expires mid-lesson, sign-in says why and brings the learner
 * back to the page they were on (client/src/lib/returnPath.js), instead of
 * dropping them on the lesson list with no explanation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { returnPath } from '../src/lib/returnPath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');
// Normalize line endings: Windows checkouts use CRLF.
const read = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

describe('returnPath', () => {
  it('returns to the in-app page that sent the learner to sign-in', () => {
    assert.equal(returnPath('/lessons/clear-email'), '/lessons/clear-email');
    assert.equal(returnPath('/settings'), '/settings');
    assert.equal(returnPath('/plato/users?filter=pending'), '/plato/users?filter=pending');
  });

  it('falls back to the lesson list for anything else', () => {
    for (const from of [undefined, null, '', 42, 'lessons', 'https://evil.example', '//evil.example', '/\\evil.example']) {
      assert.equal(returnPath(from), '/lessons', String(from));
    }
  });

  it('never returns to an auth page, which would only loop', () => {
    for (const from of ['/login', '/login?next=1', '/signup', '/waitlist', '/forgot-password', '/reset-password/abc']) {
      assert.equal(returnPath(from), '/lessons', from);
    }
    assert.equal(returnPath('/loginhelp'), '/loginhelp');
  });
});

describe('session expiry wiring', () => {
  it('records the page in the sign-in redirect and returns to it once signed in', () => {
    const app = read('App.jsx');
    assert.match(app, /<Navigate to="\/login" replace state=\{\{ from: `\$\{location\.pathname\}\$\{location\.search\}` \}\} \/>/);
    assert.match(app, /if \(loggedIn\) return <Navigate to=\{returnPath\(location\.state\?\.from\)\} replace \/>/);

    const login = read('pages/Login.jsx');
    assert.match(login, /const returnTo = returnPath\(location\.state\?\.from\);/);
    assert.equal(login.match(/navigate\(returnTo, \{ replace: true \}\)/g)?.length, 2, 'password and Google sign-in both return');
    assert.equal(/navigate\('\/lessons'/.test(login), false);
  });

  it('signs out with a reason instead of navigating itself, so the redirect keeps its state', () => {
    const shell = read('components/AppShell.jsx');
    assert.match(shell, /if \(sessionExpired\) logout\(\{ reason: 'expired' \}\);/);
    assert.equal(/logout\(\)\.then\(\(\) => navigate\('\/login'/.test(shell), false);

    const auth = read('contexts/AuthContext.jsx');
    assert.match(auth, /const logout = useCallback\(async \(\{ reason = null \} = \{\}\) =>/);
    assert.match(auth, /setSignedOutReason\(reason\);/);
    assert.equal(auth.match(/setSignedOutReason\(null\);/g)?.length, 2, 'password and Google sign-in clear it');
  });

  it('tells the learner why they were signed out', () => {
    const login = read('pages/Login.jsx');
    assert.match(login, /signedOutReason === 'expired' && \(\s*<p [^>]*role="status"/);
    assert.match(login, /Your session expired, so you were signed out\. Sign in again to continue\./);
  });
});
