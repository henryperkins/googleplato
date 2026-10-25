import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiConfigurationKey,
  aiConfigurationLabel,
  aiModelName,
  bedrockCredentialWarning,
  pendingAiSettingsChanges,
  savedAiSettingsMessage,
  testedAiConfiguration,
} from '../src/lib/aiSettingsPresentation.js';

const deepseek = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const mistral = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const settings = {
  provider: 'bedrock', workersAiModel: deepseek, bedrockModel: 'qwen3-vl-235b',
  awsRegion: 'us-east-2', version: 3,
  workersAiModels: [{ id: deepseek, name: 'DeepSeek V4.1 Flash 1017' }, { id: mistral, name: 'Mistral Small 3.1 24B' }],
};

describe('AI Settings configuration presentation', () => {
  it('identifies the saved Bedrock model and region independently of Cloudflare preferences', () => {
    assert.match(aiConfigurationLabel(settings), /Amazon Bedrock.*Qwen3-VL 235B A22B.*us-east-2/);
    assert.doesNotMatch(aiConfigurationLabel(settings), /DeepSeek/);
    assert.equal(aiConfigurationKey(settings), aiConfigurationKey({ ...settings, workersAiModel: mistral, version: 4 }));
    assert.notEqual(aiConfigurationKey(settings), aiConfigurationKey({ ...settings, awsRegion: 'us-west-2' }));
  });

  it('identifies each Cloudflare model and falls back to an unknown model ID', () => {
    assert.match(aiConfigurationLabel({ ...settings, provider: 'workers-ai' }), /Cloudflare Workers AI.*DeepSeek/);
    assert.notEqual(aiConfigurationKey({ ...settings, provider: 'workers-ai' }), aiConfigurationKey({ ...settings, provider: 'workers-ai', workersAiModel: mistral }));
    assert.equal(aiModelName(settings, 'workers-ai', '@cf/new/model'), '@cf/new/model');
    assert.equal(aiModelName({ ...settings, bedrockModel: 'future-model' }, 'bedrock'), 'future-model');
  });

  it('shows the old and proposed model for a model-only change', () => {
    const changes = pendingAiSettingsChanges({ ...settings, provider: 'workers-ai' }, { provider: 'workers-ai', workersAiModel: mistral });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].label, 'Cloudflare model');
    assert.match(changes[0].before, /DeepSeek/);
    assert.match(changes[0].after, /Mistral/);
    assert.equal(changes[0].inactive, false);
  });

  it('keeps a hidden Cloudflare edit explicit when Bedrock is selected again', () => {
    const changes = pendingAiSettingsChanges(settings, { provider: 'bedrock', workersAiModel: mistral });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].inactive, true);
    assert.match(changes[0].label, /future switches/i);
    const saved = savedAiSettingsMessage({ ...settings, workersAiModel: mistral }, changes);
    assert.match(saved, /New requests use Amazon Bedrock/);
    assert.match(saved, /Mistral.*future switches/i);
  });

  it('reports provider and model changes separately and clears the diff after saving', () => {
    const draft = { provider: 'workers-ai', workersAiModel: mistral };
    assert.equal(pendingAiSettingsChanges(settings, draft).length, 2);
    const saved = { ...settings, ...draft };
    assert.deepEqual(pendingAiSettingsChanges(saved, draft), []);
    assert.match(savedAiSettingsMessage(saved, []), /Cloudflare Workers AI.*Mistral/);
  });

  it('binds test results to the returned provider and model, rather than a different draft', () => {
    const candidate = { ...settings, provider: 'workers-ai', workersAiModel: mistral };
    const tested = testedAiConfiguration(candidate, { provider: 'workers-ai', model: deepseek });
    assert.match(aiConfigurationLabel(tested), /DeepSeek/);
    assert.notEqual(aiConfigurationKey(tested), aiConfigurationKey(candidate));
    const bedrock = testedAiConfiguration(candidate, { provider: 'bedrock', model: 'qwen3-vl-235b' });
    assert.match(aiConfigurationLabel(bedrock), /Amazon Bedrock.*Qwen3-VL/);
    assert.notEqual(aiConfigurationKey(testedAiConfiguration(candidate, { provider: 'unknown', model: mistral })), aiConfigurationKey(candidate));
  });

  it('warns about Bedrock only when the server reports no AWS credentials', () => {
    assert.equal(bedrockCredentialWarning(settings), null, 'servers that predate the check report nothing');
    assert.equal(bedrockCredentialWarning({ ...settings, bedrockCredentials: { configured: true } }), null);
    assert.equal(bedrockCredentialWarning(null), null);
    const warning = bedrockCredentialWarning({ ...settings, bedrockCredentials: { configured: false } });
    assert.match(warning, /No AWS credentials/);
    assert.match(warning, /instance role/, 'presence checks cannot see an instance role, so the copy must not overclaim');
  });

  it('uses the captured request configuration if a proxy omits response metadata', () => {
    assert.equal(aiConfigurationKey(testedAiConfiguration(settings, { ok: true })), aiConfigurationKey(settings));
    assert.deepEqual(pendingAiSettingsChanges(settings, { provider: settings.provider, workersAiModel: settings.workersAiModel }), []);
  });
});
