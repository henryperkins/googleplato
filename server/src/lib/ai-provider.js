/**
 * All agents share the admin-selected provider and model. Keep the Messages
 * request/response contract at this boundary, including for plugin callers.
 */
import bedrock from './bedrock.js';
import workersAi from './workers-ai.js';
import { BEDROCK_MODEL, readAiSettings } from './ai-settings.js';

// Compatibility with existing browsers and ctx.LLM in plugins. The server's
// selection is authoritative; a caller-supplied model never overrides it.
export const LLM = BEDROCK_MODEL;

const ai = {
  async invoke(_model, body) {
    return ai.invokeWithSettings(await readAiSettings(), body);
  },

  async invokeWithSettings(settings, body) {
    if (settings.provider === 'workers-ai') return workersAi.invoke(settings.workersAiModel, body);
    return bedrock.invoke(BEDROCK_MODEL, body);
  },

  async *invokeStream(_model, body, options) {
    // Resolve once per request so a switch cannot change an in-flight stream.
    const settings = await readAiSettings();
    if (settings.provider === 'workers-ai') yield* workersAi.invokeStream(settings.workersAiModel, body, options);
    else yield* bedrock.invokeStream(BEDROCK_MODEL, body, options);
  },
};

export default ai;
