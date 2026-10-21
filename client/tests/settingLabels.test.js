import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeKey, settingLabel } from '../src/lib/plugins/settingLabels.js';

describe('settingLabel', () => {
  it('humanizes camelCase, snake_case, and kebab-case keys', () => {
    assert.equal(humanizeKey('botToken'), 'Bot token');
    assert.equal(humanizeKey('workspaceName'), 'Workspace name');
    assert.equal(humanizeKey('connected'), 'Connected');
    assert.equal(humanizeKey('api_key'), 'Api key');
    assert.equal(humanizeKey('max-retries'), 'Max retries');
  });

  it('prefers an explicit schema title', () => {
    assert.equal(settingLabel('botToken', { title: 'Slack bot token' }), 'Slack bot token');
  });

  it('falls back to the humanized key without a title', () => {
    assert.equal(settingLabel('botToken', {}), 'Bot token');
    assert.equal(settingLabel('botToken', undefined), 'Bot token');
  });
});
