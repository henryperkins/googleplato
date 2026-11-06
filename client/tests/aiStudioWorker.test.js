import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function runHead(navigator) {
  const context = {
    navigator,
    localStorage: { getItem: () => null },
    window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: { classList: { add() {} } } },
  };
  for (const [, script] of html.split('</head>')[0].matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInNewContext(script, context);
  }
}

describe('AI Studio worker registration compatibility', () => {
  it('registers the injected worker at the origin root on a nested page', async () => {
    let registered;
    const workers = {
      register(script) {
        registered = new URL(script, 'https://classroom.example/plato/customizer/');
        return Promise.resolve({ scope: new URL('.', registered).href });
      },
    };
    runHead({ serviceWorker: workers });
    const result = await workers.register('./_service-worker.js');
    assert.equal(registered.href, 'https://classroom.example/_service-worker.js');
    assert.equal(result.scope, 'https://classroom.example/');
  });

  it('preserves other worker URLs, options, receiver, and the registration promise', () => {
    const result = Promise.resolve({ scope: 'unchanged' });
    const options = { scope: '/app/', type: 'module', updateViaCache: 'none' };
    const calls = [];
    const workers = { register(...args) { calls.push({ receiver: this, args }); return result; } };
    runHead({ serviceWorker: workers });
    for (const script of ['/app/worker.js', './other-worker.js', '/_service-worker.js', 'https://other.example/_service-worker.js', new URL('https://classroom.example/worker.js')]) {
      assert.equal(workers.register(script, options), result);
      const call = calls.at(-1);
      assert.equal(call.receiver, workers);
      assert.equal(call.args[0], script);
      assert.equal(call.args[1], options);
    }
  });

  it('preserves failures from the browser registration API', async () => {
    const failure = new Error('Registration denied');
    const workers = { register() { return Promise.reject(failure); } };
    runHead({ serviceWorker: workers });
    await assert.rejects(workers.register('./_service-worker.js'), error => error === failure);
  });

  it('loads when the browser does not support service workers', () => {
    assert.doesNotThrow(() => runHead({}));
  });
});
