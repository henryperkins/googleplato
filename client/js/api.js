/**
 * AI API utilities — parsing and streaming helpers.
 * All API calls go through the server proxy (authenticatedFetch).
 */

// Compatibility hint for older servers. The server's saved admin provider/model
// takes precedence for every agent; browsers never choose the active backend.
export const LLM = 'qwen3-vl-235b';

export class ApiError extends Error {
  constructor(type, message, status, code, retryAfterMs) {
    super(message);
    this.name = 'ApiError';
    this.type = type;   // 'invalid_key' | 'rate_limit' | 'network' | 'parse' | 'api' | 'empty_response'
    this.status = status;
    // Server classification (e.g. 'ai_unavailable', 'empty_message'), which
    // client/src/lib/aiErrors.js turns into contextual copy.
    this.code = code;
    // How long the server asked us to wait when it is busy (server ai-errors.js).
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) this.retryAfterMs = retryAfterMs;
  }
}

// Wait as long as the server asked (busy AI service or this account's own
// limit), else back off exponentially from 3 s. Jitter keeps a room of
// learners from retrying in step after the same throttle.
export const MAX_RETRY_WAIT_MS = 30_000;
export function retryDelay(error, attempt, random = Math.random) {
  const base = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 3000 * 2 ** attempt;
  return Math.min(base, MAX_RETRY_WAIT_MS) + Math.round(random() * 0.25 * base);
}

/**
 * Drop messages with no content. The AI route rejects them, as Bedrock would,
 * and an empty turn left by a failed reply should not block the next send.
 */
export function withoutEmptyMessages(messages) {
  return (messages || []).filter((m) => (typeof m.content === 'string'
    ? m.content.trim().length > 0
    : Array.isArray(m.content) && m.content.length > 0));
}

/**
 * Parse a Messages API response.
 * Expects a fetch Response object. Returns { content, usage }.
 */
export async function parseResponse(resp) {
  if (!resp.ok) {
    const status = resp.status;
    let body;
    try { body = await resp.json(); } catch { body = {}; }
    const msg = body?.error?.message || body?.error || `API returned ${status}`;
    const code = body?.code || body?.error?.code;
    const retryAfterMs = Number(body?.retryAfterMs ?? body?.error?.retryAfterMs) || undefined;

    if (status === 401) throw new ApiError('invalid_key', 'Session expired. Please sign in again.', status, code);
    // A configuration failure needs an admin, not the orchestrator's automatic
    // overload retries. Preserve its stable code and surface-specific guidance.
    if (code === 'ai_unavailable') throw new ApiError('api', msg, status, code);
    if (status === 429) throw new ApiError('rate_limit', 'Rate limited. Try again in a moment.', status, code, retryAfterMs);
    if (status === 503 || status === 529) throw new ApiError('overloaded', 'API is temporarily overloaded. Retrying...', status, code, retryAfterMs);
    if (status === 500) throw new ApiError('api', 'Internal server error. This may be a temporary issue.', status, code);
    throw new ApiError('api', msg, status, code);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new ApiError('parse', 'Failed to parse API response.');
  }

  const textBlock = data.content?.find(b => b.type === 'text');
  if (!textBlock) throw new ApiError('parse', 'No text content in API response.');

  if (data.stop_reason === 'max_tokens') {
    console.warn('[plato] Response truncated — max_tokens reached. Output may be incomplete.');
  }

  return { content: textBlock.text, usage: data.usage };
}

/**
 * Parse an SSE stream from the Messages API proxy.
 * Yields text delta strings as they arrive.
 */
export async function* parseSSEStream(body, onDone, { failOnTruncation = false } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;

        let event;
        try { event = JSON.parse(data); } catch { continue; }

        // A provider failure mid-stream. Ignoring it used to make the reply
        // look empty, and the empty turn then tripped the server's
        // empty-content check on the next send, hiding the real cause.
        if (event.type === 'error') {
          throw new ApiError('api', event.error?.message || 'The AI service failed to respond.', undefined, event.error?.code, event.error?.retryAfterMs);
        }
        if (failOnTruncation && event.type === 'message_delta' && event.delta?.stop_reason === 'max_tokens') {
          throw new ApiError('truncated', 'The reply was cut off. Please try again.');
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield event.delta.text;
        }
      }
    }
    throw new ApiError('network', 'The response stream ended before it was complete. Please try again.');
  } finally {
    reader.releaseLock();
    onDone?.();
  }
}
