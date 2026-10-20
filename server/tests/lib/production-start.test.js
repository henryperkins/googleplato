import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('production startup refuses ephemeral storage and development credentials before connecting', () => {
  const start = env => spawnSync(process.execPath, ['start.js'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, DB_BACKEND: 'postgres', JWT_SECRET: 'x'.repeat(48), APP_URL: 'https://example.test', ...env },
    encoding: 'utf8', timeout: 5000,
  });
  for (const backend of ['', 'sqlite', 'misspelled']) {
    const result = start({ DB_BACKEND: backend });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production requires DB_BACKEND/);
  }
  const secret = start({ JWT_SECRET: 'dev-secret' });
  assert.equal(secret.status, 1);
  assert.match(secret.stderr, /stable JWT_SECRET/);
  const origin = start({ APP_URL: 'http://localhost:3000' });
  assert.equal(origin.status, 1);
  assert.match(origin.stderr, /HTTPS APP_URL/);
});
