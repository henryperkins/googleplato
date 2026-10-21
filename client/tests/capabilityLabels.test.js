import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityLabel } from '../src/lib/plugins/capabilityLabels.js';

describe('capabilityLabel', () => {
  it('renders known static capabilities as plain language', () => {
    assert.equal(capabilityLabel('server.routes'), 'Add server API routes');
    assert.equal(capabilityLabel('settings.read'), 'Read its own settings');
    assert.equal(capabilityLabel('settings.write'), 'Update its own settings');
    assert.equal(capabilityLabel('user.metadata.read'), 'Read per-user records');
    assert.equal(capabilityLabel('user.metadata.write'), 'Write per-user records');
    assert.equal(capabilityLabel('lessonEnrichment'), 'Add reference material when a lesson starts');
    assert.equal(capabilityLabel('agent'), 'Provide AI agents');
    assert.equal(capabilityLabel('kpi'), 'Contribute dashboard metrics');
    assert.equal(capabilityLabel('ui.adminNav'), 'Add an admin navigation entry');
    assert.equal(capabilityLabel('syncData.namespace'), 'Store per-user data');
  });

  it('renders known hooks and slots as plain language', () => {
    assert.equal(capabilityLabel('hook.lessonStarted'), 'Run when a lesson starts');
    assert.equal(capabilityLabel('hook.userCreated'), 'Run when a user is created');
    assert.equal(capabilityLabel('ui.slot.adminSettingsPanel'), 'Show a settings panel on the Plugins page');
    assert.equal(capabilityLabel('ui.slot.adminProfileFields'), 'Show a section on the Edit User page');
  });

  it('humanizes unknown hooks and slots instead of showing raw tokens', () => {
    assert.equal(capabilityLabel('hook.lessonResumed'), 'Run on the lesson resumed event');
    assert.equal(capabilityLabel('ui.slot.adminHomeKpi'), 'Show a metric on the admin dashboard');
    assert.equal(capabilityLabel('ui.slot.someFutureSlot'), 'Render in the some future slot area');
  });

  it('keeps unrecognized capabilities visible as their raw token', () => {
    assert.equal(capabilityLabel('future.thing'), 'future.thing');
  });

  it('returns empty text for missing input', () => {
    assert.equal(capabilityLabel(''), '');
    assert.equal(capabilityLabel(null), '');
    assert.equal(capabilityLabel(undefined), '');
  });
});
