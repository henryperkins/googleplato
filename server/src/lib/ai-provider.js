/**
 * All agents share the admin-selected provider and model. Keep the Messages
 * request/response contract at this boundary, including for plugin callers.
 */
import bedrock from './bedrock.js';
import workersAi from './workers-ai.js';
import { BEDROCK_MODEL, readAiSettings } from './ai-settings.js';
import { createInferenceTelemetry, currentInferenceContext } from './inference-telemetry.js';
import { classifyAiError } from './ai-errors.js';

// Compatibility with existing browsers and ctx.LLM in plugins. The server's
// selection is authoritative; a caller-supplied model never overrides it.
export const LLM = BEDROCK_MODEL;

const ai = {
  async invoke(_model, body, options) {
    return ai.invokeWithSettings(await readAiSettings(), body, options);
  },

  async invokeWithSettings(settings, body, { context } = {}) {
    const { adapter, model, telemetry } = invocation(settings, false, context);
    let outcome = 'error', errorCode;
    try {
      const result = await adapter.invoke(model, body, { observe: telemetry.observe });
      for (const block of result.content || []) if (block.type === 'text') telemetry.visible(block.text);
      outcome = 'success';
      return result;
    } catch (error) {
      errorCode = classifyAiError(error).code;
      throw error;
    } finally { telemetry.finish(outcome, errorCode); }
  },

  async *invokeStream(_model, body, { signal, context } = {}) {
    // Resolve once per request so a switch cannot change an in-flight stream.
    const settings = await readAiSettings();
    const { adapter, model, telemetry } = invocation(settings, true, context);
    let outcome = 'cancelled', errorCode;
    try {
      for await (const event of adapter.invokeStream(model, body, { signal, observe: telemetry.observe })) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') telemetry.visible(event.delta.text);
        yield event;
      }
      outcome = signal?.aborted ? 'cancelled' : 'success';
    } catch (error) {
      outcome = signal?.aborted ? 'cancelled' : 'error';
      errorCode = classifyAiError(error).code;
      throw error;
    } finally { telemetry.finish(outcome, errorCode); }
  },
};

function invocation(settings, stream, context) {
  const workers = settings.provider === 'workers-ai';
  const model = workers ? settings.workersAiModel : BEDROCK_MODEL;
  return { adapter: workers ? workersAi : bedrock, model,
    telemetry: createInferenceTelemetry({ provider: settings.provider, model, stream, context: context ?? currentInferenceContext(),
      region: workers ? 'global' : process.env.AWS_REGION || 'us-east-2' }) };
}

export default ai;
