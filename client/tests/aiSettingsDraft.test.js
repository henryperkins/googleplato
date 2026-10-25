import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearAiSettingsDraft, rememberAiSettingsDraft, restoreAiSettingsDraft } from '../src/lib/aiSettingsDraft.js';
import { requireAiSettingsResponse } from '../src/lib/aiSettingsPresentation.js';

const settings = {
  provider: 'workers-ai', workersAiModel: 'model-a', version: 4, bedrockModel: 'bedrock-model', awsRegion: 'us-east-2',
  workersAiModels: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }],
  workersAiCredentials: { configured: true },
};
const draft = { provider: 'workers-ai', workersAiModel: 'model-b' };
function storage() {
  const values = new Map();
  return { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key) };
}

describe('AI Settings tab drafts', () => {
  it('retains choices through repeated reads for only their original administrator', () => {
    const store = storage();
    assert.equal(rememberAiSettingsDraft(store, 'draft-owner', settings, draft), true);
    assert.equal(restoreAiSettingsDraft(store, 'another-owner', settings), null);
    assert.deepEqual(restoreAiSettingsDraft(store, 'draft-owner', settings), { draft });
    assert.deepEqual(restoreAiSettingsDraft(store, 'draft-owner', settings), { draft });
    clearAiSettingsDraft(store, 'draft-owner');
    assert.equal(restoreAiSettingsDraft(store, 'draft-owner', settings), null);
  });

  it('does not silently rebase a draft onto another settings version', () => {
    const store = storage();
    rememberAiSettingsDraft(store, 'stale-owner', settings, draft);
    assert.deepEqual(restoreAiSettingsDraft(store, 'stale-owner', { ...settings, version: 5 }), { changed: true });
    assert.equal(restoreAiSettingsDraft(store, 'stale-owner', settings), null);
  });

  it('keeps a navigation fallback when storage fails and discards it explicitly', () => {
    const blocked = { setItem() { throw new Error('Blocked'); }, removeItem() { throw new Error('Blocked'); } };
    assert.equal(rememberAiSettingsDraft(blocked, 'blocked-owner', settings, draft), false);
    assert.deepEqual(restoreAiSettingsDraft(blocked, 'blocked-owner', settings), { draft });
    clearAiSettingsDraft(blocked, 'blocked-owner');
    assert.equal(restoreAiSettingsDraft(blocked, 'blocked-owner', settings), null);
  });

  it('rejects unsupported and malformed drafts without touching another owner', () => {
    const store = storage();
    assert.equal(rememberAiSettingsDraft(store, 'bad-provider', settings, { ...draft, provider: 'unknown' }), false);
    assert.equal(rememberAiSettingsDraft(store, 'bad-model', settings, { ...draft, workersAiModel: 'unknown' }), false);
    store.setItem('plato:ai-settings-draft:malformed-owner', '{broken');
    assert.equal(restoreAiSettingsDraft(store, 'malformed-owner', settings), null);
    assert.equal(restoreAiSettingsDraft(store, '', settings), null);
  });
});

describe('AI Settings response boundaries', () => {
  it('accepts complete settings without changing names or fields', () => {
    const complete = { ...settings, workersAiOAuth: { available: true, connected: true, version: 1, account: { name: 'فصل دراسي — 学習室' }, pendingAccounts: [] } };
    assert.equal(requireAiSettingsResponse(complete), complete);
  });

  it('rejects incomplete settings and malformed display fields before rendering', () => {
    for (const value of [null, {}, [], { ...settings, provider: 'constructor' },
      { ...settings, workersAiModels: null }, { ...settings, workersAiModels: [{ id: 'model-a', name: {} }] },
      { ...settings, workersAiCredentials: null }, { ...settings, version: -1 },
      { ...settings, workersAiOAuth: { account: { name: {} } } },
      { ...settings, workersAiOAuth: { pendingAccounts: [{ name: 'No ID' }] } },
      { ...settings, workersAiOAuth: { connected: true } },
      { ...settings, workersAiOAuth: { connected: true, version: -1 } },
      { ...settings, workersAiOAuth: { pendingAccounts: [{ id: 'account', name: 'Account' }] } },
      { ...settings, workersAiOAuth: { connected: 'false' } }]) {
      assert.throws(() => requireAiSettingsResponse(value), /incomplete AI settings/);
    }
  });

  it('requires explicit connection status to confirm a connection mutation', () => {
    assert.equal(requireAiSettingsResponse(settings), settings, 'older manual-only settings remain readable');
    assert.throws(() => requireAiSettingsResponse(settings, { connectionRequired: true }), /incomplete AI settings/);
    assert.throws(() => requireAiSettingsResponse({ ...settings, workersAiOAuth: {} }, { connectionRequired: true }), /incomplete AI settings/);
    const confirmed = { ...settings, workersAiOAuth: { available: true, connected: false, needsReconnect: false, connectionPending: false, revocationPending: true, version: 2 } };
    assert.equal(requireAiSettingsResponse(confirmed, { connectionRequired: true }), confirmed);
  });
});
