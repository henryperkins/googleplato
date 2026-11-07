import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

let vite;
let SettingsForm;
let effectivePluginSettings;
let settingsForSave;
let validateRequiredSettings;
let withoutWriteOnly;
let defaultsRestoredBy;
let savedSettingsMessage;
let settingHint;

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
  ({
    default: SettingsForm, effectivePluginSettings, settingsForSave, validateRequiredSettings,
    withoutWriteOnly, defaultsRestoredBy, savedSettingsMessage, settingHint,
  } = await vite.ssrLoadModule('/src/lib/plugins/SettingsForm.jsx'));
});

after(async () => {
  await vite?.close();
});

const render = (properties, settings = {}, required = [], storedWriteOnly = []) => renderToStaticMarkup(createElement(SettingsForm, {
  pluginId: 'example',
  pluginName: 'Example',
  schema: { type: 'object', properties, required },
  settings,
  storedWriteOnly,
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
    assert.match(html, /<button[^>]*aria-label="Save Example settings"[^>]*>Save<\/button>/);
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
    assert.match(html, /<select[^>]*class="[^"]*border-input[^"]*bg-transparent/);
  });

  it('shows effective defaults and connects required labels, help, and fields', () => {
    const html = render({
      apiKey: { type: 'string', title: 'API key', description: 'Public browser key.', default: 'default-key' },
    }, {}, ['apiKey']);
    assert.match(html, />API key<span[^>]*> \(required\)<\/span><\/label>/);
    assert.match(html, /aria-describedby="plugin-example-apiKey-description"/);
    assert.match(html, /aria-required="true"/);
    assert.match(html, /id="plugin-example-apiKey-description"/);
    assert.match(html, /value="default-key"/);
  });

  it('drops blank declared strings and validates required effective values', () => {
    const schema = {
      type: 'object',
      required: ['apiKey', 'projectId'],
      properties: {
        apiKey: { type: 'string', title: 'API key', default: 'default-key' },
        projectId: { type: 'string', title: 'Project ID' },
        note: { type: 'string' },
      },
    };
    assert.deepEqual(settingsForSave(schema, { apiKey: ' \t ', note: '\n', undeclared: '  ' }), { undeclared: '  ' });
    assert.deepEqual(validateRequiredSettings(schema, { apiKey: '', projectId: '' }), { projectId: 'Project ID is required.' });
    assert.deepEqual(validateRequiredSettings(schema, { apiKey: '', projectId: 'project' }), {});
    assert.deepEqual(effectivePluginSettings(schema, { projectId: 'stored' }), { apiKey: 'default-key', projectId: 'stored' });
  });

  it('counts a stored required secret as set while its field is blank', () => {
    const schema = {
      type: 'object',
      required: ['apiSecret'],
      properties: {
        apiSecret: { type: 'string', title: 'API secret', writeOnly: true },
        region: { type: 'string', default: 'us' },
      },
    };
    // The server never returns the secret, so the form only knows it exists.
    assert.deepEqual(validateRequiredSettings(schema, { region: 'eu' }, ['apiSecret']), {});
    assert.deepEqual(validateRequiredSettings(schema, { apiSecret: '  ', region: 'eu' }, ['apiSecret']), {});
    assert.deepEqual(validateRequiredSettings(schema, { region: 'eu' }), { apiSecret: 'API secret is required.' });
    assert.deepEqual(validateRequiredSettings(schema, { apiSecret: 'new', region: 'eu' }), {});
    // A typed secret leaves the form once saved; other values stay.
    assert.deepEqual(withoutWriteOnly(schema, { apiSecret: 'new', region: 'eu' }), { region: 'eu' });
  });

  it('names the fields a save returns to their defaults', () => {
    const schema = {
      type: 'object',
      properties: {
        apiKey: { type: 'string', title: 'API key', default: 'key' },
        authDomain: { type: 'string', title: 'Auth domain', default: 'example.test' },
        projectId: { type: 'string', title: 'Project ID', default: 'project' },
        note: { type: 'string' },
        secret: { type: 'string', writeOnly: true, default: 'never shown' },
      },
    };
    assert.deepEqual(defaultsRestoredBy(schema, { apiKey: ' ', authDomain: 'kept.example', note: '', secret: '' }), ['apiKey']);
    assert.equal(savedSettingsMessage(schema, []), 'Settings saved.');
    assert.equal(savedSettingsMessage(schema, ['apiKey']), 'Settings saved. API key was reset to its default.');
    assert.equal(savedSettingsMessage(schema, ['apiKey', 'authDomain']), 'Settings saved. API key and Auth domain were reset to their defaults.');
    assert.equal(savedSettingsMessage(schema, ['apiKey', 'authDomain', 'projectId']),
      'Settings saved. API key, Auth domain, and Project ID were reset to their defaults.');
  });

  it('explains what saving does with a hidden secret or a cleared default', () => {
    const secret = { type: 'string', writeOnly: true };
    assert.equal(settingHint(secret, '', true), 'A value is saved. Leave this blank to keep it.');
    assert.equal(settingHint(secret, 'replacement', true), 'Saving replaces the saved value.');
    assert.equal(settingHint(secret, '', false), null);
    assert.equal(settingHint({ type: 'string', default: 'key' }, '  ', false), 'Saving restores the default.');
    assert.equal(settingHint({ type: 'string', default: 'key' }, 'custom', false), null);
    assert.equal(settingHint({ type: 'string' }, '', false), null);

    const html = render({ apiSecret: { type: 'string', title: 'API secret', description: 'From the service dashboard.', writeOnly: true } },
      {}, ['apiSecret'], ['apiSecret']);
    assert.match(html, /<input[^>]*type="password"[^>]*autoComplete="off"|<input[^>]*autoComplete="off"[^>]*type="password"/i);
    assert.match(html, /aria-describedby="plugin-example-apiSecret-description plugin-example-apiSecret-hint"/);
    assert.match(html, /<p id="plugin-example-apiSecret-hint"[^>]*>A value is saved\. Leave this blank to keep it\.<\/p>/);
  });
});
