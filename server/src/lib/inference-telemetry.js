import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from './logger.js';
import { aiErrorDiagnostics } from './ai-errors.js';

const AGENTS = new Set(['coach', 'coach-assessment-repair', 'lesson-owner', 'lesson-creator', 'lesson-extractor', 'knowledge-base-editor',
  'knowledge-base-extractor', 'learner-profile-owner', 'learner-profile-update', 'course-progress-update', 'lesson-enrichment', 'admin-test']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const id = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const requestContext = new AsyncLocalStorage();
export const withInferenceContext = (context, fn) => requestContext.run(context, fn);
export const currentInferenceContext = () => requestContext.getStore();

// Only fixed metadata crosses into logs. The authenticated principal owns the
// namespace; client-supplied actor/status/usage fields are never trusted.
export function inferenceContext(userId, raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const context = { agent_role: AGENTS.has(raw.agentRole) ? raw.agentRole : 'unknown' };
  if (typeof userId !== 'string' || !userId) return context;
  context.actor_ref = hash(userId);
  if (id(raw.operationId)) context.operation_ref = hash(userId, raw.operationId);
  if (count(raw.retryIndex) !== null && raw.retryIndex <= 20) context.client_retry_index = raw.retryIndex;
  if (id(raw.lessonId) && (raw.generation === null || id(raw.generation))) {
    context.lesson_ref = hash(userId, raw.lessonId);
    context.attempt_ref = hash(userId, raw.lessonId, raw.generation);
    if (id(raw.turnId)) context.turn_ref = hash(userId, raw.lessonId, raw.generation, raw.turnId);
  }
  return context;
}

export function normalizeUsage(format, usage = {}) {
  usage ||= {};
  const prompt = count(format === 'workers-ai' ? usage.prompt_tokens : format === 'converse' ? usage.inputTokens : usage.input_tokens);
  const output = count(format === 'workers-ai' ? usage.completion_tokens : format === 'converse' ? usage.outputTokens : usage.output_tokens);
  let reasoning = count(format === 'workers-ai' ? usage.completion_tokens_details?.reasoning_tokens : usage.reasoning_tokens);
  if (output !== null && reasoning > output) reasoning = null;
  return {
    prompt_tokens: prompt, output_tokens: output, reasoning_tokens: reasoning,
    visible_output_tokens: output !== null && reasoning !== null ? output - reasoning : null,
    cached_input_tokens: count(format === 'workers-ai' ? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
      : format === 'converse' ? usage.cacheReadInputTokens : usage.cache_read_input_tokens),
    cache_write_tokens: format === 'workers-ai' ? 0 : count(format === 'converse' ? usage.cacheWriteInputTokens : usage.cache_creation_input_tokens),
  };
}

// Instrumentation must not become another inference/save failure mode.
export function observeInference(observer, sample) {
  try { observer?.(sample); } catch { /* optional telemetry */ }
}
function emit(code, meta) {
  try { logger.info(code, meta); } catch { /* optional telemetry */ }
}
function warn(code, meta) {
  try { logger.warn(code, meta); } catch { /* optional telemetry */ }
}
// Failures are also a WARN, so they can be counted and alerted on apart from
// the INFO measurements. Identifiers only, never the error's message.
function warnFailure(sink, identity, errorCode, error) {
  try { sink('ai_provider_error', { schema_version: 1, ...identity, error_code: errorCode, ...aiErrorDiagnostics(error) }); }
  catch { /* optional telemetry */ }
}

/** The AI selection could not be read, so no provider, model or invocation exists yet. */
export function recordSettingsFailure({ stream = false, context = {} } = {}, errorCode, error, { warn: warningSink = warn } = {}) {
  warnFailure(warningSink, { inference_id: null, provider: null, model: null, stream,
    agent_role: AGENTS.has(context?.agent_role) ? context.agent_role : 'unknown' }, errorCode, error);
}

export function recordLessonAttemptSaved(userId, lessonId, turnId, state) {
  const context = inferenceContext(userId, { lessonId, generation: state.generation, turnId });
  if (!context.attempt_ref) return;
  emit('lesson_attempt_saved', { ...context, schema_version: 1,
    lesson_attempt_status: state.lessonKB.data?.status === 'completed' ? 'completed' : 'active' });
}

export function createInferenceTelemetry({ provider, model, region, stream = false, context = {} } = {}, {
  now = () => performance.now(), emit: sink = emit, warn: warningSink = warn,
} = {}) {
  const started = now();
  const common = { schema_version: 1, inference_id: randomUUID(), provider, model, region, stream,
    agent_role: AGENTS.has(context.agent_role) ? context.agent_role : 'unknown' };
  // Do not spread arbitrary plugin options into structured logs.
  for (const name of ['actor_ref', 'lesson_ref', 'attempt_ref', 'turn_ref', 'operation_ref']) {
    if (/^[a-f0-9]{64}$/.test(context[name] || '')) common[name] = context[name];
  }
  if (count(context.client_retry_index) !== null && context.client_retry_index <= 20) common.client_retry_index = context.client_retry_index;
  const write = (code, meta) => { try { sink(code, meta); } catch { /* optional telemetry */ } };
  write('inference_started', common);
  const usage = normalizeUsage('unknown');
  let firstVisible = null, attempts = null, retryDelay = null, finalUsage = false, finished = false;
  return {
    observe(sample) {
      if (!sample || finished) return;
      if (sample.usage) {
        const normalized = normalizeUsage(sample.format, sample.usage);
        // A breakdown from an earlier cumulative snapshot cannot describe
        // additional output whose reasoning split was not reported.
        if (normalized.output_tokens !== null && normalized.output_tokens !== usage.output_tokens
          && normalized.reasoning_tokens === null) usage.reasoning_tokens = null;
        if (normalized.prompt_tokens !== null && normalized.prompt_tokens !== usage.prompt_tokens) {
          for (const key of ['cached_input_tokens', 'cache_write_tokens']) if (normalized[key] === null) usage[key] = null;
        }
        for (const [key, value] of Object.entries(normalized)) if (value !== null) usage[key] = value;
        if (usage.output_tokens !== null && usage.reasoning_tokens > usage.output_tokens) usage.reasoning_tokens = null;
        usage.visible_output_tokens = usage.output_tokens !== null && usage.reasoning_tokens !== null
          ? usage.output_tokens - usage.reasoning_tokens : null;
        finalUsage ||= sample.finalUsage === true;
      }
      if (count(sample.attempts) !== null && sample.attempts > 0) attempts = sample.attempts;
      if (count(sample.retryDelayMs) !== null) retryDelay = sample.retryDelayMs;
    },
    visible(text) {
      if (firstVisible === null && typeof text === 'string' && text.trim()) firstVisible = now() - started;
    },
    fail(errorCode, error) {
      if (finished) return;
      warnFailure(warningSink, { inference_id: common.inference_id, provider, model, stream, agent_role: common.agent_role }, errorCode, error);
    },
    finish(outcome, errorCode) {
      if (finished) return;
      finished = true;
      write('inference_finished', { ...common, ...usage, outcome,
        ...(errorCode ? { error_code: errorCode } : {}),
        time_to_first_visible_token_ms: firstVisible === null ? null : Math.max(0, Math.round(firstVisible)),
        ttft_scope: 'server_provider', latency_ms: Math.max(0, Math.round(now() - started)),
        provider_attempts: attempts, provider_retries: attempts === null ? null : attempts - 1,
        provider_retry_delay_ms: retryDelay,
        usage_complete: finalUsage && usage.prompt_tokens !== null && usage.output_tokens !== null && attempts === 1,
      });
    },
  };
}
