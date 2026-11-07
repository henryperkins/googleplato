import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { needsAuthenticatedClient, resolveSettingsPanel, resolveSlotComponent } from '../src/lib/plugins/resolvers.js';

const Panel = () => null;
const RowAction = () => null;

describe('needsAuthenticatedClient', () => {
  it('does not import a public-auth-only provider into signed-in pages', () => {
    const googleAuth = { extensionPoints: { slots: { publicAuthProvider: 'client/GoogleAuthProvider.jsx' } }, settingsSchema: {} };
    assert.equal(needsAuthenticatedClient(googleAuth), false);
  });

  it('loads plugins with a signed-in slot, even alongside a public one', () => {
    const slack = { extensionPoints: { slots: { adminSettingsPanel: 'client/SlackSettingsPanel.jsx' } } };
    assert.equal(needsAuthenticatedClient(slack), true);
    const mixed = { extensionPoints: { slots: { publicAuthProvider: 'a.jsx', adminSettingsPanel: 'b.jsx' } } };
    assert.equal(needsAuthenticatedClient(mixed), true);
  });

  it('keeps loading plugins that declare no slots (a top-level settingsPanel export)', () => {
    assert.equal(needsAuthenticatedClient({ settingsSchema: {} }), true);
    assert.equal(needsAuthenticatedClient({}), true);
    assert.equal(needsAuthenticatedClient(undefined), true);
  });
});

describe('resolveSettingsPanel', () => {
  it('resolves a slot.adminSettingsPanel from default-exported plugin module', () => {
    // Matches the actual Slack plugin shape: `export default { slots: { adminSettingsPanel: Panel } }`
    const mod = { default: { slots: { adminSettingsPanel: Panel } } };
    assert.equal(resolveSettingsPanel(mod), Panel);
  });

  it('resolves slot.adminSettingsPanel from named-namespace exports', () => {
    const mod = { slots: { adminSettingsPanel: Panel } };
    assert.equal(resolveSettingsPanel(mod), Panel);
  });

  it('falls back to top-level settingsPanel (default export)', () => {
    const mod = { default: { settingsPanel: Panel } };
    assert.equal(resolveSettingsPanel(mod), Panel);
  });

  it('falls back to top-level settingsPanel (named-namespace)', () => {
    const mod = { settingsPanel: Panel };
    assert.equal(resolveSettingsPanel(mod), Panel);
  });

  it('prefers slot.adminSettingsPanel over the top-level settingsPanel', () => {
    const Other = () => null;
    const mod = { default: { slots: { adminSettingsPanel: Panel }, settingsPanel: Other } };
    assert.equal(resolveSettingsPanel(mod), Panel);
  });

  it('returns null when no panel is exported', () => {
    assert.equal(resolveSettingsPanel({}), null);
    assert.equal(resolveSettingsPanel({ default: {} }), null);
    assert.equal(resolveSettingsPanel(undefined), null);
    assert.equal(resolveSettingsPanel(null), null);
  });
});

describe('resolveSlotComponent', () => {
  it('resolves a slot from default-exported plugin module', () => {
    const mod = { default: { slots: { adminUserRowAction: RowAction } } };
    assert.equal(resolveSlotComponent(mod, 'adminUserRowAction'), RowAction);
  });

  it('resolves a slot from named-namespace exports', () => {
    const mod = { slots: { adminUserRowAction: RowAction } };
    assert.equal(resolveSlotComponent(mod, 'adminUserRowAction'), RowAction);
  });

  it('returns null for an unmapped slot', () => {
    const mod = { default: { slots: { adminSettingsPanel: Panel } } };
    assert.equal(resolveSlotComponent(mod, 'adminUserRowAction'), null);
  });

  it('returns null for an undefined module', () => {
    assert.equal(resolveSlotComponent(undefined, 'adminSettingsPanel'), null);
  });
});
