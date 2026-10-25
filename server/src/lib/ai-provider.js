/**
 * All agents share the admin-selected provider and model. Keep the Messages
 * request/response contract at this boundary, including for plugin callers.
 */
import bedrock from './bedrock.js';
import workersAi from './workers-ai.js';
import { BEDROCK_MODEL, readAiSettings } from './ai-settings.js';
import { createInferenceTelemetry, currentInferenceContext, recordSettingsFailure } from './inference-telemetry.js';
import { classifyAiError } from './ai-errors.js';

// Compatibility with existing browsers and ctx.LLM in plugins. The server's
// selection is authoritative; a caller-supplied model never overrides it.
export const LLM = BEDROCK_MODEL;

const ai = {
  async invoke(_model, body, options) {
    return ai.invokeWithSettings(await selectedSettings(false, options?.context), body, options);
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
      telemetry.fail(errorCode, error);
      throw error;
    } finally { telemetry.finish(outcome, errorCode); }
  },

  async *invokeStream(_model, body, { signal, context } = {}) {
    // Resolve once per request so a switch cannot change an in-flight stream.
    const settings = await selectedSettings(true, context);
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
      if (outcome === 'error') telemetry.fail(errorCode, error);
      throw error;
    } finally { telemetry.finish(outcome, errorCode); }
  },
};

// The selection is read before an adapter or measurement exists, so report a
// failure here too: an invalid AI_PROVIDER would otherwise fail every request
// silently. A database error is a server error, never an unreachable provider.
async function selectedSettings(stream, context) {
  try { return await readAiSettings(); }
  catch (error) {
    const failure = error?.name === 'AiConfigurationError' ? error : Object.assign(new Error('AI settings could not be read.'), {
      name: 'AiSettingsError', aiStage: 'settings', causeName: error?.name, causeCode: error?.code,
    });
    recordSettingsFailure({ stream, context: context ?? currentInferenceContext() }, classifyAiError(failure).code, failure);
    throw failure;
  }
}

function invocation(settings, stream, context) {
  const workers = settings.provider === 'workers-ai';
  const model = workers ? settings.workersAiModel : BEDROCK_MODEL;
  return { adapter: workers ? workersAi : bedrock, model,
    telemetry: createInferenceTelemetry({ provider: settings.provider, model, stream, context: context ?? currentInferenceContext(),
      region: workers ? 'global' : process.env.AWS_REGION || 'us-east-2' }) };
}

export default ai;
