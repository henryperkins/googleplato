/**
 * Classify an AI provider failure into a stable code for the browser.
 *
 * The client maps the code, plus the surface that made the call, to
 * contextual copy (client/src/lib/aiErrors.js). The raw provider message never
 * leaves the server, and logs never record it either: an AWS AccessDenied
 * message can include the account ID and IAM role name. aiErrorDiagnostics()
 * keeps only identifiers for the ai_provider_error event.
 */

const MESSAGES = {
  ai_unavailable: 'The AI service is unavailable.',
  ai_rate_limited: 'The AI service is rate limiting requests.',
  ai_overloaded: 'The AI service is temporarily overloaded.',
  ai_timeout: 'The AI service did not respond in time.',
  ai_invalid_request: 'The AI service could not process the request.',
  ai_error: 'The AI service failed to respond.',
};

// Missing or rejected credentials, no model access, or an unknown model ID.
// None of these clear up on retry; an operator has to fix configuration.
const UNAVAILABLE = new Set([
  'AiConfigurationError',
  'CredentialsProviderError',
  'AccessDeniedException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'ExpiredTokenException',
  'ResourceNotFoundException',
]);

const RATE_LIMITED = new Set(['ThrottlingException', 'ServiceQuotaExceededException']);
// AiCredentialsTemporaryError: another request is still renewing the shared
// Cloudflare token, or the renewal could not reach Cloudflare. Credential reads
// that fail unexpectedly (AiCredentialsError) fall through to ai_error.
const OVERLOADED = new Set(['ServiceUnavailableException', 'ModelNotReadyException', 'InternalServerException', 'AiCredentialsTemporaryError']);
const TIMEOUT = new Set(['ModelTimeoutException', 'TimeoutError', 'AbortError']);
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);

/** @returns {{ code: string, message: string }} */
export function classifyAiError(err) {
  const name = err?.name || '';
  const status = err?.$metadata?.httpStatusCode ?? err?.status;
  let code = 'ai_error';

  if (UNAVAILABLE.has(name) || status === 401 || status === 403 || status === 404) code = 'ai_unavailable';
  else if (RATE_LIMITED.has(name) || status === 429) code = 'ai_rate_limited';
  // Before the generic 5xx check: a model timeout can arrive as a 408 or 5xx.
  else if (TIMEOUT.has(name) || status === 408 || status === 504 || /timed out/i.test(String(err?.message || ''))) code = 'ai_timeout';
  else if (name === 'ValidationException' || status === 400) code = 'ai_invalid_request';
  else if (OVERLOADED.has(name) || status >= 500) code = 'ai_overloaded';
  else if (NETWORK.has(err?.code) || NETWORK.has(err?.cause?.code)) code = 'ai_unavailable';

  return { code, message: MESSAGES[code] };
}

const IDENTIFIER = /^[\w.-]{1,64}$/;
/** An error name or code fit for logs, or null for anything that could be free text. */
export const safeIdentifier = value => typeof value === 'string' && IDENTIFIER.test(value) ? value : null;
const CREDENTIAL_SOURCES = new Set(['oauth', 'oauth-refreshed', 'environment']);

/**
 * Content-free fields for the ai_provider_error log: names, codes and statuses,
 * never a message. A credential failure reports its cause's identity, which
 * workersAiCredentials() copies onto the error it throws.
 */
export function aiErrorDiagnostics(err) {
  const status = err?.httpStatus ?? err?.$metadata?.httpStatusCode;
  return {
    stage: err?.aiStage === 'credentials' || err?.name === 'CredentialsProviderError' ? 'credentials' : 'provider',
    reason: safeIdentifier(err?.reason),
    error_name: safeIdentifier(err?.causeName ?? err?.name),
    http_status: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
    cause_code: safeIdentifier(err?.causeCode ?? err?.code ?? err?.cause?.code),
    credential_source: CREDENTIAL_SOURCES.has(err?.credentialSource) ? err.credentialSource : null,
    token_expires_in_s: Number.isSafeInteger(err?.tokenExpiresInS) ? err.tokenExpiresInS : null,
  };
}

export function aiErrorStatus(code) {
  return ({
    ai_unavailable: 503,
    ai_rate_limited: 429,
    ai_overloaded: 503,
    ai_timeout: 504,
    ai_invalid_request: 400,
  })[code] || 502;
}
