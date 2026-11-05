import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Link the production auth module to a controlled Firebase boundary, without
// importing Firebase's browser persistence or changing the normal test flags.
test('Google sign-in reports invitation-only admission without starting a session', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/googleAdmission.js', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-vm-modules', '--test', '--test-reporter=tap', fixture], { env });
    assert.match(stdout, /# fail 0/);
  } catch (error) {
    assert.fail(`${error.stdout || ''}\n${error.stderr || error.message}`);
  }
});
