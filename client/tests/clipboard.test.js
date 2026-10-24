/**
 * copyText — clipboard writes that report failure instead of assuming
 * success — and the copy-link contract: every admin copy-link action goes
 * through CopyLinkField, which announces the result and falls back to a
 * selected, read-only field when the clipboard is denied or missing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { copyText } = await import('../src/lib/clipboard.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../src', rel), 'utf8').replace(/\r\n/g, '\n');

describe('copyText', () => {
  it('resolves true once the write resolves', async () => {
    const writes = [];
    const ok = await copyText('https://x/signup?token=t1', { writeText: async (t) => { writes.push(t); } });
    assert.equal(ok, true);
    assert.deepEqual(writes, ['https://x/signup?token=t1']);
  });

  it('resolves false when the browser denies the write', async () => {
    const denied = { writeText: () => Promise.reject(new Error('NotAllowedError')) };
    assert.equal(await copyText('x', denied), false);
  });

  it('resolves false when writeText throws synchronously', async () => {
    const broken = { writeText: () => { throw new TypeError('Illegal invocation'); } };
    assert.equal(await copyText('x', broken), false);
  });

  it('resolves false when the Clipboard API is unavailable', async () => {
    assert.equal(await copyText('x', undefined), false);
    assert.equal(await copyText('x', {}), false);
  });
});

describe('copy-link UI contract', () => {
  it('admin copy-link actions use CopyLinkField, not a bare clipboard write', () => {
    const users = read('pages/admin/AdminUsers.jsx');
    assert.doesNotMatch(users, /navigator\.clipboard/);
    assert.equal((users.match(/<CopyLinkField\b/g) || []).length, 2);
  });

  it('CopyLinkField reports both outcomes and falls back to a selected field', () => {
    const field = read('components/CopyLinkField.jsx');
    assert.match(field, /if \(await copyText\(value\)\)/);
    assert.match(field, /<Input[\s\S]*?readOnly[\s\S]*?value=\{value\}/);
    // The status region is always mounted; only its text changes.
    assert.match(field, /<p role="status"/);
    assert.match(field, /'copied' && 'Copied to the clipboard\.'/);
    assert.match(field, /'failed' && "Couldn't copy automatically\./);
    assert.match(field, /setResult\('failed'\);\s*\n\s*inputRef\.current\?\.focus\(\);\s*\n\s*if \(inputRef\.current\) selectAll\(inputRef\.current\);/);
  });
});
