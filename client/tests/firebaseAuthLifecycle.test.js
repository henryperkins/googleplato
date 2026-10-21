import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Link the production module to a controlled SDK boundary, without importing
// Firebase's browser persistence or changing the normal test command's flags.
test('Firebase sign-in and sign-out lifecycle regressions', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/firebaseAuthLifecycle.js', import.meta.url));
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-vm-modules', '--test', '--test-reporter=tap', fixture], { env });
    assert.match(stdout, /# fail 0/);
  } catch (error) {
    assert.fail(`${error.stdout || ''}\n${error.stderr || error.message}`);
  }
});
