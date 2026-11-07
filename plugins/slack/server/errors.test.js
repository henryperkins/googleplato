import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { slackErrorBody } = await import('./index.js');

test('Slack error responses keep the platform code and a missing scope for the settings panel', () => {
  // Shapes thrown by @slack/web-api: platform errors carry Slack's response.
  const missingScope = Object.assign(new Error('An API error occurred: missing_scope'), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'missing_scope', needed: 'channels:read', provided: 'chat:write' },
  });
  assert.deepEqual(slackErrorBody(missingScope, 'Slack API error'), {
    error: 'Slack API error',
    detail: 'An API error occurred: missing_scope',
    code: 'missing_scope',
    needed: 'channels:read',
  });

  const revoked = Object.assign(new Error('An API error occurred: invalid_auth'), {
    code: 'slack_webapi_platform_error', data: { ok: false, error: 'invalid_auth' },
  });
  assert.equal(slackErrorBody(revoked, 'Invalid token or Slack API error').code, 'invalid_auth');

  // Request, HTTP and rate-limit failures have no response body; keep the client's code.
  const offline = Object.assign(new Error('A request error occurred: getaddrinfo ENOTFOUND slack.com'), { code: 'slack_webapi_request_error' });
  assert.equal(slackErrorBody(offline, 'Slack API error').code, 'slack_webapi_request_error');

  const plain = slackErrorBody(new Error('boom'), 'Slack API error');
  assert.deepEqual(plain, { error: 'Slack API error', detail: 'boom' });
});
