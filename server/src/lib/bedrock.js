/** Amazon Bedrock adapter. Callers use ai-provider.js to honor the admin selection. */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { toConverseRequest, fromConverseResponse, fromConverseStreamEvent } from './converse.js';
import { observeInference } from './inference-telemetry.js';

// Timeout for Bedrock requests — set just under the Lambda function timeout
// (120 s) so errors propagate cleanly rather than causing a hard Lambda kill.
const BEDROCK_TIMEOUT_MS = 115_000;

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-2' });

// Map friendly model IDs to Bedrock model / inference-profile IDs. Open-weight
// models are invoked by bare model ID (no `us.` cross-region prefix); Anthropic
// models need the inference-profile prefix.
const MODEL_MAP = {
  'qwen3-vl-235b': 'qwen.qwen3-vl-235b-a22b',
  'claude-haiku-4-5-20251001': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
};

/** Anthropic models use the legacy InvokeModel body; everything else Converse. */
function usesLegacyInvoke(modelId) {
  return modelId.includes('anthropic.');
}

function withTimeout(label, signal) {
  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(new Error(`Bedrock ${label} timed out after ${BEDROCK_TIMEOUT_MS}ms`)),
    BEDROCK_TIMEOUT_MS,
  );
  return {
    abortSignal: signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal,
    clear: () => clearTimeout(timer),
  };
}

const ai = {
  async invoke(model, body, { observe } = {}) {
    const modelId = MODEL_MAP[model] || model;
    const { abortSignal, clear } = withTimeout('invoke');
    try {
      if (usesLegacyInvoke(modelId)) {
        const command = new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', ...body }),
        });
        const response = await client.send(command, { abortSignal });
        recordAttempts(observe, response);
        const data = JSON.parse(new TextDecoder().decode(response.body));
        observeInference(observe, { format: 'anthropic', usage: data.usage, finalUsage: true });
        return data;
      }

      const response = await client.send(new ConverseCommand(toConverseRequest(modelId, body)), { abortSignal });
      recordAttempts(observe, response);
      observeInference(observe, { format: 'converse', usage: response.usage, finalUsage: true });
      return fromConverseResponse(response);
    } catch (error) {
      recordAttempts(observe, error);
      throw error;
    } finally {
      clear();
    }
  },

  async *invokeStream(model, body, { signal, observe } = {}) {
    const modelId = MODEL_MAP[model] || model;
    const { abortSignal, clear } = withTimeout('stream', signal);
    try {
      if (usesLegacyInvoke(modelId)) {
        const command = new InvokeModelWithResponseStreamCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', ...body }),
        });
        const response = await client.send(command, { abortSignal });
        recordAttempts(observe, response);
        for await (const event of response.body) {
          if (event.chunk) {
            const data = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
            observeInference(observe, { format: 'anthropic', usage: data.message?.usage || data.usage,
              finalUsage: data.type === 'message_delta' });
            yield data;
          }
        }
        return;
      }

      const response = await client.send(new ConverseStreamCommand(toConverseRequest(modelId, body)), { abortSignal });
      recordAttempts(observe, response);
      for await (const event of response.stream) {
        observeInference(observe, { format: 'converse', usage: event.metadata?.usage, finalUsage: true });
        const translated = fromConverseStreamEvent(event);
        if (translated) yield translated;
      }
    } catch (error) {
      recordAttempts(observe, error);
      throw error;
    } finally {
      clear();
    }
  },
};

function recordAttempts(observe, response) {
  observeInference(observe, { attempts: response.$metadata?.attempts, retryDelayMs: response.$metadata?.totalRetryDelay });
}

export default ai;
