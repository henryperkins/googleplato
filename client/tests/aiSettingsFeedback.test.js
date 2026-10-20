import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectionTestErrorMessage } from '../src/lib/aiSettingsFeedback.js';

const failure = (code, status) => ({ data: { code }, status, message: 'Raw provider or transport details' });

describe('AI Settings connection recovery', () => {
  it('gives rate limits and overloads wait-and-retry guidance for either provider', () => {
    for (const provider of ['bedrock', 'workers-ai']) {
      for (const code of ['ai_rate_limited', 'ai_overloaded']) {
        const message = connectionTestErrorMessage(failure(code, 503), provider);
        assert.match(message, /wait/i);
        assert.match(message, /test.*again/i);
        assert.doesNotMatch(message, /credentials|permissions|account ID|Raw provider/i);
      }
    }
  });

  it('makes timeouts retryable without claiming a credential problem', () => {
    const message = connectionTestErrorMessage(failure('ai_timeout', 504), 'workers-ai');
    assert.match(message, /did not respond in time/i);
    assert.match(message, /test.*again/i);
    assert.doesNotMatch(message, /credentials|permissions|account ID/i);
  });

  it('reserves provider-specific configuration guidance for unavailable service access', () => {
    const cloudflare = connectionTestErrorMessage(failure('ai_unavailable', 503), 'workers-ai');
    assert.match(cloudflare, /Cloudflare Workers AI/);
    assert.match(cloudflare, /account ID.*API token.*model access/i);
    assert.doesNotMatch(cloudflare, /AWS|Bedrock/);
    const bedrock = connectionTestErrorMessage(failure('ai_unavailable', 503), 'bedrock');
    assert.match(bedrock, /Amazon Bedrock/);
    assert.match(bedrock, /AWS credentials.*region.*model access/i);
    assert.doesNotMatch(bedrock, /Cloudflare/);
  });

  it('directs rejected test requests toward model settings', () => {
    const message = connectionTestErrorMessage(failure('ai_invalid_request', 400), 'workers-ai');
    assert.match(message, /selected model.*settings/i);
    assert.doesNotMatch(message, /credentials/i);
  });

  it('keeps application authentication separate from provider authentication', () => {
    assert.match(connectionTestErrorMessage(failure(undefined, 401), 'workers-ai'), /sign in again/i);
    assert.match(connectionTestErrorMessage(failure(undefined, 403), 'bedrock'), /admin account/i);
    assert.doesNotMatch(connectionTestErrorMessage(failure(undefined, 403), 'bedrock'), /AWS credentials/i);
    assert.match(connectionTestErrorMessage(new Error('Session expired'), 'bedrock'), /sign in again/i);
  });

  it('uses transport status when a proxy omits the provider error code', () => {
    assert.match(connectionTestErrorMessage(failure(undefined, 429), 'bedrock'), /wait/i);
    assert.match(connectionTestErrorMessage(failure(undefined, 504), 'workers-ai'), /did not respond in time/i);
    assert.doesNotMatch(connectionTestErrorMessage(failure(undefined, 503), 'workers-ai'), /credentials|permissions|account ID/i);
  });

  it('distinguishes a browser network failure from provider configuration', () => {
    const message = connectionTestErrorMessage(new TypeError('Failed to fetch'), 'workers-ai');
    assert.match(message, /reach the server.*connection/i);
    assert.doesNotMatch(message, /credentials|model access/i);
  });

  it('offers recovery for unknown failures without exposing internal details', () => {
    for (const error of [undefined, new Error('Cannot parse private account payload'), failure('ai_error', 502)]) {
      const message = connectionTestErrorMessage(error, 'workers-ai');
      assert.match(message, /try again/i);
      assert.match(message, /server logs/i);
      assert.doesNotMatch(message, /private account|Raw provider|undefined|Cannot parse/i);
    }
  });
});
