import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function stopServer(mode) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createServer, get } from 'node:http';
    import { once } from 'node:events';
    import { installShutdown } from './src/lib/shutdown.js';
    const mode = process.env.SHUTDOWN_TEST_MODE;
    let responseFinished = false;
    const server = createServer((req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      if (mode !== 'open-stream') setTimeout(() => {
        res.end('saved');
        responseFinished = true;
      }, 30);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    installShutdown(server, async () => {
      if (mode === 'database-error') throw Object.assign(new Error('private connection details'), { code: 'TEST_DB_ERROR' });
      if (mode === 'database-hang') await new Promise(() => {});
      console.log(JSON.stringify({ event: 'database_closed', responseFinished }));
    }, { timeoutMs: 100 });
    if (['drain', 'open-stream'].includes(mode)) {
      const request = get({ host: '127.0.0.1', port: server.address().port, agent: false });
      const [response] = await once(request, 'response');
      response.resume();
    }
    process.kill(process.pid, 'SIGTERM');
  `], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, SHUTDOWN_TEST_MODE: mode },
    encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL',
  });
}

test('shutdown drains an in-flight response before closing the database', () => {
  const result = stopServer('drain');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { event: 'database_closed', responseFinished: true });
});

test('shutdown reports database cleanup failures without leaking connection details', () => {
  const result = stopServer('database-error');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /shutdown_error/);
  assert.deepEqual(JSON.parse(result.stderr.trim()), { event: 'shutdown_error', code: 'TEST_DB_ERROR' });
  assert.doesNotMatch(result.stderr, /private connection details/);
});

for (const mode of ['open-stream', 'database-hang']) {
  test(`shutdown bounds ${mode} instead of waiting for an external kill`, () => {
    const result = stopServer(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(result.stderr.trim()), { event: 'shutdown_timeout' });
  });
}
