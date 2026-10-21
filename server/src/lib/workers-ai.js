import { workersAiCredentials } from './cloudflare-oauth.js';
import { observeInference } from './inference-telemetry.js';

const TIMEOUT_MS = 115_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const STOP_REASONS = { stop: 'end_turn', length: 'max_tokens', content_filter: 'content_filtered', tool_calls: 'tool_use' };

function providerError(status = 502) {
  // Never retain the provider body: it may contain credentials or account data.
  return Object.assign(new Error('Cloudflare Workers AI request failed.'), { name: 'WorkersAiError', status });
}

function invalidRequest() {
  return Object.assign(new Error('Unsupported AI message content.'), { name: 'ValidationException' });
}

function toContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalidRequest();
  const blocks = content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
    if (block?.type === 'image' && block.source?.type === 'base64' && IMAGE_TYPES.has(block.source.media_type) && typeof block.source.data === 'string') {
      return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
    }
    throw invalidRequest();
  });
  return blocks.every(block => block.type === 'text') ? blocks.map(block => block.text).join('\n') : blocks;
}

export function toWorkersAiRequest(model, body, stream = false) {
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)) throw invalidRequest();
  const messages = [];
  if (body.system) {
    const content = typeof body.system === 'string' ? body.system : toContent(body.system);
    if (typeof content !== 'string') throw invalidRequest();
    messages.push({ role: 'system', content });
  }
  for (const message of body.messages || []) {
    if (!['user', 'assistant'].includes(message.role)) throw invalidRequest();
    messages.push({ role: message.role, content: toContent(message.content) });
  }
  const reasoning = model === '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
  return {
    model, messages, stream,
    // Reasoning consumes the completion budget too. Leave room for a visible
    // answer even for agents whose original text-only budget is small.
    max_tokens: (body.max_tokens || 1024) + (reasoning ? 8192 : 0),
    ...(reasoning ? { reasoning_effort: 'max' } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function usage(data) {
  return { input_tokens: data?.prompt_tokens ?? 0, output_tokens: data?.completion_tokens ?? 0 };
}

function fromResponse(data) {
  if (data?.error || data?.success === false) throw providerError();
  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw providerError();
  return {
    content: [{ type: 'text', text }],
    stop_reason: STOP_REASONS[choice.finish_reason] || null,
    usage: usage(data.usage),
  };
}

async function request(model, body, stream, signal, observe) {
  signal?.throwIfAborted();
  const credentials = await workersAiCredentials();
  signal?.throwIfAborted();
  const requestBody = JSON.stringify(toWorkersAiRequest(model, body, stream));
  observeInference(observe, { attempts: 1, retryDelayMs: 0 });
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credentials.apiToken}`, 'Content-Type': 'application/json' },
    body: requestBody,
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw providerError(response.status);
  }
  return response;
}

// Frames may be split anywhere, including inside UTF-8 characters. Flush the
// final unterminated frame and reject malformed/truncated streams explicitly.
async function* readEvents(body) {
  if (!body) throw providerError();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lines = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) buffer += '\n\n';
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
        if (line === '' && lines.length) {
          const data = lines.join('\n');
          lines = [];
          if (data === '[DONE]') return;
          let event;
          try { event = JSON.parse(data); } catch { throw providerError(); }
          yield event;
        }
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const workersAi = {
  async invoke(model, body, { observe } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await request(model, body, false, controller.signal, observe);
      const data = await response.json();
      observeInference(observe, { format: 'workers-ai', usage: data?.usage, finalUsage: true });
      return fromResponse(data);
    } finally {
      clearTimeout(timer);
    }
  },

  async *invokeStream(model, body, { signal, observe } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let finished = false;
    let hasText = false;
    let tokenUsage = usage();
    try {
      const response = await request(model, body, true, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, observe);
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw providerError();
      yield { type: 'message_start', message: { role: 'assistant', content: [] } };
      for await (const event of readEvents(response.body)) {
        observeInference(observe, { format: 'workers-ai', usage: event.usage,
          finalUsage: finished || Boolean(event.choices?.[0]?.finish_reason) });
        if (event.error || event.success === false) throw providerError(event.error?.status || 502);
        const choice = event.choices?.[0];
        const text = choice?.delta?.content;
        // Reasoning traces are intentionally excluded from learner-visible text.
        if (typeof text === 'string' && text) {
          hasText ||= Boolean(text.trim());
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
        }
        if (event.usage) tokenUsage = usage(event.usage);
        if (choice?.finish_reason) {
          finished = true;
          yield { type: 'message_delta', delta: { stop_reason: STOP_REASONS[choice.finish_reason] || null } };
        }
      }
      if (!finished || !hasText) throw providerError();
      yield { type: 'message_stop', usage: tokenUsage };
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  },
};

export default workersAi;
