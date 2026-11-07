/**
 * Limits on AI calls (upstream #516, adapted to the fork).
 *
 * Request caps on `POST /v1/ai/messages`, the proxy every signed-in user can
 * call, sized against the largest real calls (orchestrator.js, the admin
 * chats, plugins) with headroom, as upstream:
 * - `model` is required, but unlike upstream any value is accepted: the
 *   provider always uses the admin's choice (ai-provider.js), and a browser
 *   still running an older bundle may send an older model id.
 * - `max_tokens` 1–4096 (the largest agent asks for 4096: KB extraction).
 * - up to 60 messages; up to 4 images in one message and 8 in a request.
 * - a system prompt up to 200,000 characters; a body up to 5 MB.
 *
 * Per-user rate and concurrency, as upstream, but applied in ai-provider.js
 * to **every** AI call a user causes. In this fork the coach runs on the
 * server (`POST /v1/ai/coach/:lessonId`, lesson-coaching.js) and never goes
 * through `/v1/ai/messages`, so limiting only the proxy route would miss most
 * of the traffic. Keyed by the inference context's `actor_ref` (a hash of the
 * user id), in this instance's memory: a burst spread across instances can
 * exceed them. They stop one person or script from pinning the provider; the
 * provider's own account limit is the shared ceiling, and its 429s reach the
 * client typed with `retryAfterMs`.
 * - 30 calls a minute, burst 30 (a learner turn makes 1–3 calls: the coach,
 *   sometimes an assessment repair, the profile and unit-note agents).
 * - 4 calls in flight at once (a streaming reply plus its background agents).
 */
export const MAX_TOKENS_CAP = 4096;
export const MAX_MESSAGES = 60;
export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGES_TOTAL = 8;
export const MAX_SYSTEM_CHARS = 200_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const RATE_PER_MINUTE = 30;
export const MAX_IN_FLIGHT = 4;

const textOf = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('') : '');

/**
 * Check a `/v1/ai/messages` body. Returns `{ aiBody, stream }` ready for the
 * provider, or `{ error }` (a 400).
 */
export function validateAiRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid request body' };
  const { model, max_tokens: maxTokens, system, messages, stream } = body;
  if (!model || typeof model !== 'string') return { error: 'model is required' };
  let tokens = 1024;
  if (maxTokens !== undefined && maxTokens !== null) {
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_CAP) return { error: `max_tokens must be a whole number from 1 to ${MAX_TOKENS_CAP}` };
    tokens = maxTokens;
  }
  if (!messages || !Array.isArray(messages)) return { error: 'messages array is required' };
  if (messages.length === 0) return { error: 'messages must not be empty' };
  if (messages.length > MAX_MESSAGES) return { error: `At most ${MAX_MESSAGES} messages per request` };
  let images = 0;
  for (const msg of messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return { error: 'Each message needs a role of user or assistant' };
    // Providers reject empty content (Bedrock: ValidationException).
    if (!msg.content || (typeof msg.content === 'string' && !msg.content.trim()) || (Array.isArray(msg.content) && msg.content.length === 0)) {
      return { error: 'messages must have non-empty content', code: 'empty_message' };
    }
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) return { error: 'message content must be text or a list of blocks' };
    if (Array.isArray(msg.content)) {
      const here = msg.content.filter((b) => b?.type === 'image').length;
      if (here > MAX_IMAGES_PER_MESSAGE) return { error: `At most ${MAX_IMAGES_PER_MESSAGE} images per message` };
      images += here;
    }
  }
  if (images > MAX_IMAGES_TOTAL) return { error: `At most ${MAX_IMAGES_TOTAL} images per request` };
  if (system !== undefined && system !== null && typeof system !== 'string' && !Array.isArray(system)) return { error: 'system must be text' };
  if (textOf(system).length > MAX_SYSTEM_CHARS) return { error: `system prompt is too long (over ${MAX_SYSTEM_CHARS} characters)` };
  return { aiBody: { max_tokens: tokens, ...(system ? { system } : {}), messages }, stream: !!stream };
}

// ── Per-user rate (token bucket) and concurrency, per instance ─────────────
const buckets = new Map(); // actor_ref -> { tokens, at, inFlight }

function bucketFor(key, now) {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size > 10_000) {
      for (const [id, v] of buckets) if (v.inFlight === 0) buckets.delete(id); // drop idle users first
    }
    b = { tokens: RATE_PER_MINUTE, at: now, inFlight: 0 };
    buckets.set(key, b);
  }
  b.tokens = Math.min(RATE_PER_MINUTE, b.tokens + ((now - b.at) / 60_000) * RATE_PER_MINUTE);
  b.at = now;
  return b;
}

/**
 * Take one call for `key` (an `actor_ref`). Returns `{ ok: true, release }`
 * (call `release` exactly once when the call ends), or `{ ok: false,
 * retryAfterMs, reason }`. A call without a user (a plugin job, a migration)
 * is never limited.
 */
export function acquire(key, now = Date.now()) {
  if (!key) return { ok: true, release: () => {} };
  const b = bucketFor(key, now);
  if (b.inFlight >= MAX_IN_FLIGHT) return { ok: false, reason: 'in_flight', retryAfterMs: 2000 };
  if (b.tokens < 1) return { ok: false, reason: 'rate', retryAfterMs: Math.ceil(((1 - b.tokens) / RATE_PER_MINUTE) * 60_000) };
  b.tokens -= 1;
  b.inFlight += 1;
  let released = false;
  return { ok: true, release: () => { if (!released) { released = true; b.inFlight = Math.max(0, b.inFlight - 1); } } };
}

/** The error a refused call throws; ai-errors.js types it as `ai_rate_limited`. */
export function userLimitError(refusal) {
  return Object.assign(new Error('Too many AI requests from this account at once.'), {
    name: 'AiUserRateLimited', reason: refusal.reason, retryAfterMs: refusal.retryAfterMs,
  });
}

/** Tests: forget every bucket. */
export function _resetAiLimits() { buckets.clear(); }
