import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

let vite;
let SettingsForm;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    // Keep React external so server rendering shares the test's React instance.
    configFile: false,
    plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  });
  ({ default: SettingsForm } = await vite.ssrLoadModule('/src/lib/plugins/SettingsForm.jsx'));
});

after(async () => {
  await vite?.close();
});

const render = (properties, settings = {}) => renderToStaticMarkup(createElement(SettingsForm, {
  pluginId: 'example',
  schema: { type: 'object', properties },
  settings,
  onSave: async () => {},
}));

describe('Plugin settings form', () => {
  it('keeps malformed field descriptors from crashing the settings panel', () => {
    const html = render({ botToken: null, workspaceName: undefined, retryCount: 2, connected: false }, {
      botToken: 'retained value',
    });
    assert.match(html, /<label[^>]*for="plugin-example-botToken"[^>]*>Bot token<\/label>/);
    assert.match(html, /value="retained value"/);
    assert.match(html, />Workspace name<\/label>/);
    assert.match(html, />Retry count<\/label>/);
    assert.match(html, />Connected<\/label>/);
    assert.match(html, /<button[^>]*>Save<\/button>/);
  });

  it('preserves valid descriptions, titles, and typed controls', () => {
    const html = render({
      token: { type: 'string', title: 'Service token', description: 'Use a token for this workspace.', writeOnly: true },
      enabled: { type: 'boolean' },
      retries: { type: 'number', minimum: 0, maximum: 5 },
      mode: { enum: ['quiet', 'verbose'] },
    }, { enabled: true, retries: 3, mode: 'quiet' });
    assert.match(html, />Service token<\/label>/);
    assert.match(html, /Use a token for this workspace\./);
    assert.match(html, /type="password"/);
    assert.match(html, /type="checkbox"[^>]*checked=""/);
    assert.match(html, /type="number"[^>]*min="0"[^>]*max="5"/);
    assert.match(html, /<select[^>]*id="plugin-example-mode"/);
    assert.match(html, /<option value="quiet" selected="">quiet<\/option>/);
  });
});
