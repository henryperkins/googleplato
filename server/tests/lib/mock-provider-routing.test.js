import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('synthetic mock provider retains settings and connectivity interfaces', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const ai = (await import('./src/lib/ai-provider.js')).default;
    const { readAiSettings } = await import('./src/lib/ai-settings.js');
    assert.equal((await readAiSettings()).provider, 'bedrock');
    const result = await ai.invokeWithSettings({ provider: 'bedrock' }, { messages: [{ role: 'user', content: 'Test' }] });
    assert.ok(result.content[0].text);
  `], { cwd: new URL('../../', import.meta.url), env: { ...process.env, AI_PROVIDER: 'mock', NODE_ENV: 'test', K_SERVICE: '', AWS_LAMBDA_FUNCTION_NAME: '', DB_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
