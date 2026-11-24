/** Google Gemini adapter for AI Studio environments with GEMINI_API_KEY. */

import { GoogleGenAI } from '@google/genai';
import { observeInference } from './inference-telemetry.js';

const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_TIMEOUT_MS = 115_000;

const STOP_REASONS = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  STOP_SEQUENCE: 'stop_sequence',
};

function createClient() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(new Error('Gemini API key is not configured.'), {
      name: 'CredentialsProviderError',
    });
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function toSystemInstruction(system) {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const text = system
      .filter(block => block?.type === 'text' && block.text)
      .map(block => block.text)
      .join('\n\n');
    return text || undefined;
  }
  return undefined;
}

function toParts(content) {
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ text: String(content ?? '') }];
  }
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text') {
      parts.push({ text: String(block.text ?? '') });
    } else if (block?.type === 'image' && block.source?.data) {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type || 'image/jpeg',
          data: block.source.data,
        },
      });
    }
  }
  return parts.length > 0 ? parts : [{ text: '' }];
}

export function toGeminiParams(body = {}, abortSignal) {
  const contents = (body.messages || []).map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: toParts(msg.content),
  }));
  const systemInstruction = toSystemInstruction(body.system);
  const config = {
    maxOutputTokens: body.max_tokens ?? 4096,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.stop_sequences?.length ? { stopSequences: body.stop_sequences } : {}),
    ...(abortSignal ? { abortSignal } : {}),
  };
  return {
    model: GEMINI_MODEL,
    contents,
    config,
  };
}

function toUsage(usageMetadata) {
  if (!usageMetadata) return { input_tokens: 0, output_tokens: 0 };
  const inputTokens = Number.isSafeInteger(usageMetadata.promptTokenCount) ? usageMetadata.promptTokenCount : 0;
  const outputTokens = Number.isSafeInteger(usageMetadata.candidatesTokenCount) ? usageMetadata.candidatesTokenCount : 0;
  const reasoningTokens = Number.isSafeInteger(usageMetadata.thoughtsTokenCount) ? usageMetadata.thoughtsTokenCount : undefined;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens + (reasoningTokens || 0),
    ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
  };
}

function toStopReason(finishReason) {
  return STOP_REASONS[finishReason] || 'end_turn';
}

function withTimeout(label, signal) {
  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(new Error(`Gemini ${label} timed out after ${GEMINI_TIMEOUT_MS}ms`)),
    GEMINI_TIMEOUT_MS,
  );
  return {
    abortSignal: signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal,
    clear: () => clearTimeout(timer),
  };
}

const gemini = {
  async invoke(_model, body, { observe } = {}) {
    const ai = createClient();
    const { abortSignal, clear } = withTimeout('invoke');
    try {
      observeInference(observe, { attempts: 1, retryDelayMs: 0 });
      const response = await ai.models.generateContent(toGeminiParams(body, abortSignal));
      const usage = toUsage(response.usageMetadata);
      observeInference(observe, { format: 'anthropic', usage, finalUsage: true });
      const finishReason = response.candidates?.[0]?.finishReason;
      return {
        content: [{ type: 'text', text: response.text || '' }],
        stop_reason: toStopReason(finishReason),
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      };
    } finally {
      clear();
    }
  },

  async *invokeStream(_model, body, { signal, observe } = {}) {
    const ai = createClient();
    const { abortSignal, clear } = withTimeout('stream', signal);
    try {
      observeInference(observe, { attempts: 1, retryDelayMs: 0 });
      const stream = await ai.models.generateContentStream(toGeminiParams(body, abortSignal));
      yield { type: 'message_start', message: { role: 'assistant', content: [] } };
      let lastUsage = { input_tokens: 0, output_tokens: 0 };
      let stopReason = 'end_turn';
      for await (const chunk of stream) {
        if (chunk.usageMetadata) {
          lastUsage = toUsage(chunk.usageMetadata);
        }
        const finishReason = chunk.candidates?.[0]?.finishReason;
        if (finishReason) {
          stopReason = toStopReason(finishReason);
        }
        const text = chunk.text;
        if (text) {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          };
        }
      }
      observeInference(observe, { format: 'anthropic', usage: lastUsage, finalUsage: true });
      yield { type: 'message_delta', delta: { stop_reason: stopReason } };
      yield {
        type: 'message_stop',
        usage: { input_tokens: lastUsage.input_tokens, output_tokens: lastUsage.output_tokens },
      };
    } finally {
      clear();
    }
  },
};

export default gemini;
