import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aiErrorDiagnostics, classifyAiError, safeIdentifier } from '../../src/lib/ai-errors.js';

function awsError(name, httpStatusCode, message = `${name} message`) {
  const err = new Error(message);
  err.name = name;
  if (httpStatusCode) err.$metadata = { httpStatusCode };
  return err;
}

describe('classifyAiError', () => {
  it('treats missing credentials and denied model access as unavailable', () => {
    assert.equal(classifyAiError(awsError('CredentialsProviderError')).code, 'ai_unavailable');
    assert.equal(classifyAiError(awsError('AccessDeniedException', 403)).code, 'ai_unavailable');
    assert.equal(classifyAiError(awsError('ResourceNotFoundException', 404)).code, 'ai_unavailable');
  });

  it('never echoes the provider message, which can carry account details', () => {
    const err = awsError('AccessDeniedException', 403,
      'User: arn:aws:sts::123456789012:assumed-role/plato-api/fn is not authorized to perform: bedrock:InvokeModel');
    const { message } = classifyAiError(err);
    assert.equal(message, 'The AI service is unavailable.');
    assert.doesNotMatch(message, /arn:|123456789012/);
  });

  it('separates rate limits, overload, and timeouts', () => {
    assert.equal(classifyAiError(awsError('ThrottlingException', 429)).code, 'ai_rate_limited');
    assert.equal(classifyAiError(awsError('ServiceUnavailableException', 503)).code, 'ai_overloaded');
    assert.equal(classifyAiError(awsError('ModelNotReadyException')).code, 'ai_overloaded');
    assert.equal(classifyAiError(awsError('ModelTimeoutException', 408)).code, 'ai_timeout');
    assert.equal(classifyAiError(new Error('Bedrock stream timed out after 115000ms')).code, 'ai_timeout');
  });

  it('flags requests the provider rejected as invalid', () => {
    assert.equal(classifyAiError(awsError('ValidationException', 400)).code, 'ai_invalid_request');
  });

  it('treats unreachable endpoints as unavailable', () => {
    const err = new Error('getaddrinfo ENOTFOUND bedrock-runtime.us-east-2.amazonaws.com');
    err.code = 'ENOTFOUND';
    assert.equal(classifyAiError(err).code, 'ai_unavailable');
  });

  it('falls back to a generic code for anything else', () => {
    assert.deepEqual(classifyAiError(new Error('boom')), { code: 'ai_error', message: 'The AI service failed to respond.' });
    assert.equal(classifyAiError(undefined).code, 'ai_error');
  });

  it('keeps temporary credential failures retryable and a database network error a server error', () => {
    assert.equal(classifyAiError(Object.assign(new Error('Renewing.'), { name: 'AiCredentialsTemporaryError' })).code, 'ai_overloaded');
    const database = Object.assign(new Error('Workers AI credentials could not be loaded.'), {
      name: 'AiCredentialsError', aiStage: 'credentials', causeName: 'Error', causeCode: 'ECONNREFUSED',
    });
    assert.equal(classifyAiError(database).code, 'ai_error');
  });
});

describe('aiErrorDiagnostics', () => {
  it('records names and statuses but never the provider message', () => {
    const err = awsError('AccessDeniedException', 403,
      'User: arn:aws:sts::123456789012:assumed-role/plato-api/fn is not authorized to perform: bedrock:InvokeModel');
    const diagnostics = aiErrorDiagnostics(err);
    assert.deepEqual(diagnostics, {
      stage: 'provider', reason: null, error_name: 'AccessDeniedException', http_status: 403,
      cause_code: null, credential_source: null, token_expires_in_s: null,
    });
    assert.doesNotMatch(JSON.stringify(diagnostics), /arn:|123456789012/);
    assert.equal(aiErrorDiagnostics(awsError('CredentialsProviderError')).stage, 'credentials');
  });

  it('reports a credential failure by its cause and a network failure by its code', () => {
    assert.deepEqual(aiErrorDiagnostics(Object.assign(new Error('Workers AI credentials could not be loaded.'), {
      name: 'AiCredentialsError', aiStage: 'credentials', reason: null, causeName: 'error', causeCode: '57P01',
    })), {
      stage: 'credentials', reason: null, error_name: 'error', http_status: null,
      cause_code: '57P01', credential_source: null, token_expires_in_s: null,
    });
    const fetchFailure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
    });
    assert.equal(aiErrorDiagnostics(fetchFailure).error_name, 'TypeError');
    assert.equal(aiErrorDiagnostics(fetchFailure).cause_code, 'ECONNREFUSED');
    assert.doesNotMatch(JSON.stringify(aiErrorDiagnostics(fetchFailure)), /10\.0\.0\.1/);
    assert.equal(aiErrorDiagnostics(Object.assign(new Error('x'), { name: 'AiSettingsError', aiStage: 'settings' })).stage, 'settings');
    assert.equal(aiErrorDiagnostics(Object.assign(new Error('x'), { aiStage: 'anything-else' })).stage, 'provider');
    assert.equal(classifyAiError(Object.assign(new Error('AI settings could not be read.'), { name: 'AiSettingsError', causeCode: 'ECONNREFUSED' })).code, 'ai_error');
  });

  it('drops any value that could be free text', () => {
    const err = Object.assign(new Error('token=secret'), {
      name: 'Error: token=secret', code: 'password authentication failed for user plato', reason: 'x'.repeat(65),
      httpStatus: '401', credentialSource: 'stolen-token', tokenExpiresInS: 1.5,
    });
    assert.deepEqual(aiErrorDiagnostics(err), {
      stage: 'provider', reason: null, error_name: null, http_status: null,
      cause_code: null, credential_source: null, token_expires_in_s: null,
    });
    assert.equal(safeIdentifier('UND_ERR_CONNECT_TIMEOUT'), 'UND_ERR_CONNECT_TIMEOUT');
    assert.equal(safeIdentifier('57P01'), '57P01');
    assert.equal(safeIdentifier('reconnect-required'), 'reconnect-required');
    assert.equal(safeIdentifier(20), null);
    for (const value of ['10.1.2.3', 'dash.cloudflare.com', 'fd00::1']) assert.equal(safeIdentifier(value), null, value);
  });
});
