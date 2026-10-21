// List-price estimates for reported tokens, not invoices. No inference or DB
// writes here. Use an explicit rate card for regional/contract Bedrock prices.
export const DEFAULT_RATE_CARD = {
  version: 'cloudflare-list-2026-10-21',
  source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  rates: [
    { provider: 'workers-ai', model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', region: 'global',
      input_usd_per_million: 0.3, cached_input_usd_per_million: 0.006, output_usd_per_million: 1.2 },
    { provider: 'workers-ai', model: '@cf/mistralai/mistral-small-3.1-24b-instruct', region: 'global',
      input_usd_per_million: 0.351, output_usd_per_million: 0.555 },
  ],
};
export const INFERENCE_CODES = ['inference_started', 'inference_finished', 'lesson_attempt_saved'];
const tokenFields = ['prompt_tokens', 'output_tokens', 'reasoning_tokens', 'visible_output_tokens'];
const count = n => Number.isSafeInteger(n) && n >= 0;
const money = n => Number(n.toFixed(12));

function validateRateCard(card) {
  if (!card || typeof card.version !== 'string' || !card.version || !Array.isArray(card.rates)) throw new Error('Invalid rate card');
  const keys = new Set();
  for (const rate of card.rates) {
    if (!rate || !['workers-ai', 'bedrock'].includes(rate.provider) || typeof rate.model !== 'string' || !rate.model
      || typeof rate.region !== 'string' || !rate.region) throw new Error('Invalid rate identity');
    for (const key of ['input_usd_per_million', 'output_usd_per_million', 'cached_input_usd_per_million', 'cache_write_usd_per_million']) {
      if (rate[key] === undefined && key.startsWith('cache')) continue;
      if (!Number.isFinite(rate[key]) || rate[key] < 0 || rate[key] > 1_000_000) throw new Error('Invalid token rate');
    }
    const key = JSON.stringify([rate.provider, rate.model, rate.region]);
    if (keys.has(key)) throw new Error('Duplicate token rate');
    keys.add(key);
  }
}

export function estimateInferenceCost(meta, rateCard = DEFAULT_RATE_CARD) {
  validateRateCard(rateCard);
  const rate = rateCard.rates.find(r => r.provider === meta.provider && r.model === meta.model && r.region === meta.region);
  const result = { estimated_cost_usd: null, cache_assumed_uncached: false, cache_assumed_zero_write: false };
  if (!rate || !count(meta.prompt_tokens) || !count(meta.output_tokens)) return result;
  const cached = count(meta.cached_input_tokens) ? meta.cached_input_tokens : 0;
  const written = count(meta.cache_write_tokens) ? meta.cache_write_tokens : 0;
  if (meta.provider === 'workers-ai' && cached > meta.prompt_tokens) return result;
  // Cloudflare prompt_tokens includes cached input; Bedrock inputTokens does
  // not include cache reads/writes. Output includes reasoning: never add it.
  const uncached = meta.provider === 'workers-ai' ? meta.prompt_tokens - cached : meta.prompt_tokens;
  if (meta.provider === 'bedrock' && ((cached && rate.cached_input_usd_per_million === undefined)
    || (written && rate.cache_write_usd_per_million === undefined))) return result;
  result.cache_assumed_uncached = !count(meta.cached_input_tokens) && rate.cached_input_usd_per_million !== undefined;
  result.cache_assumed_zero_write = !count(meta.cache_write_tokens) && rate.cache_write_usd_per_million !== undefined;
  result.estimated_cost_usd = money((uncached * rate.input_usd_per_million
    + cached * (rate.cached_input_usd_per_million ?? rate.input_usd_per_million)
    + written * (rate.cache_write_usd_per_million ?? rate.input_usd_per_million)
    + meta.output_tokens * rate.output_usd_per_million) / 1_000_000);
  return result;
}

function distribution(values) {
  values.sort((a, b) => a - b);
  const quantile = p => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  return { samples: values.length, p50: quantile(0.5), p95: quantile(0.95) };
}

function summarize(invocations, rateCard) {
  const result = { invocations: invocations.length, missing_start_events: 0, missing_finish_events: 0,
    failures: 0, cancelled: 0, client_retry_invocations: 0, provider_retries: 0, provider_retries_unknown: 0,
    observation_invocations: 0, coaching_turns: 0, observation_operations: 0,
    unpriced_invocations: 0, incomplete_usage_invocations: 0, cache_assumed_invocations: 0,
    tokens: Object.fromEntries(tokenFields.map(key => [key, { reported: 0, missing: 0 }])),
    estimated_cost_usd: null, cost_complete: true };
  const costs = [], latencies = [], ttfts = [], coachTurns = new Set(), observations = new Set();
  for (const invocation of invocations) {
    const meta = invocation.finished || invocation.started;
    if (!invocation.started) result.missing_start_events++;
    if (!invocation.finished) result.missing_finish_events++;
    if (meta.outcome === 'error') result.failures++;
    if (meta.outcome === 'cancelled') result.cancelled++;
    if (count(meta.client_retry_index) && meta.client_retry_index > 0) result.client_retry_invocations++;
    if (count(meta.provider_retries)) result.provider_retries += meta.provider_retries;
    else result.provider_retries_unknown++;
    if (meta.agent_role === 'coach') coachTurns.add(meta.turn_ref || meta.inference_id);
    if (meta.agent_role === 'learner-profile-update') {
      result.observation_invocations++;
      observations.add(meta.operation_ref || meta.inference_id);
    }
    for (const key of tokenFields) {
      if (count(meta[key])) result.tokens[key].reported += meta[key]; else result.tokens[key].missing++;
    }
    if (count(meta.latency_ms)) latencies.push(meta.latency_ms);
    if (count(meta.time_to_first_visible_token_ms)) ttfts.push(meta.time_to_first_visible_token_ms);
    if (meta.usage_complete !== true) result.incomplete_usage_invocations++;
    const cost = estimateInferenceCost(meta, rateCard);
    if (cost.estimated_cost_usd === null) result.unpriced_invocations++; else costs.push(cost.estimated_cost_usd);
    if (cost.cache_assumed_uncached || cost.cache_assumed_zero_write) result.cache_assumed_invocations++;
  }
  result.coaching_turns = coachTurns.size;
  result.observation_operations = observations.size;
  result.observations_per_coaching_turn = coachTurns.size ? observations.size / coachTurns.size : null;
  result.estimated_cost_usd = costs.length || !invocations.length ? money(costs.reduce((a, b) => a + b, 0)) : null;
  result.cost_complete = !result.unpriced_invocations && !result.incomplete_usage_invocations && !result.missing_finish_events
    && !result.provider_retries && !result.provider_retries_unknown && !result.cache_assumed_invocations;
  result.latency_ms = distribution(latencies);
  result.time_to_first_visible_token_ms = distribution(ttfts);
  return result;
}

export function summarizeInferenceLogs(scan, { rateCard = DEFAULT_RATE_CARD, abandonAfterMs = 86400_000 } = {}) {
  if (scan?.complete !== true || scan.error) throw new Error('Cloud Logging scan incomplete; costs and outcomes are unknown');
  const since = Date.parse(scan.since), until = Date.parse(scan.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until || !Array.isArray(scan.entries)) throw new Error('Invalid inference report window');
  if (!Number.isFinite(abandonAfterMs) || abandonAfterMs <= 0) throw new Error('Invalid abandonment interval');
  validateRateCard(rateCard);
  const invocations = new Map(), attempts = new Map();
  const attemptFor = (ref, ts) => {
    let attempt = attempts.get(ref);
    if (!attempt) { attempt = { attempt_ref: ref, first_seen: ts, last_seen: ts, completed: false, invocations: [] }; attempts.set(ref, attempt); }
    if (Date.parse(ts) < Date.parse(attempt.first_seen)) attempt.first_seen = ts;
    if (Date.parse(ts) > Date.parse(attempt.last_seen)) attempt.last_seen = ts;
    return attempt;
  };
  for (const entry of scan.entries) {
    if (!INFERENCE_CODES.includes(entry.code)) continue;
    const meta = entry.meta, time = Date.parse(entry.ts);
    if (!meta || meta.schema_version !== 1 || !Number.isFinite(time)) throw new Error('Invalid inference event');
    if (time < since || time > until) continue;
    if (entry.code === 'lesson_attempt_saved') {
      if (!meta.attempt_ref || !['completed', 'active'].includes(meta.lesson_attempt_status)) throw new Error('Invalid lesson attempt event');
      const attempt = attemptFor(meta.attempt_ref, entry.ts);
      attempt.completed ||= meta.lesson_attempt_status === 'completed';
      continue;
    }
    if (!meta.inference_id || !meta.provider || !meta.model) throw new Error('Invalid inference identity');
    let invocation = invocations.get(meta.inference_id);
    if (!invocation) { invocation = {}; invocations.set(meta.inference_id, invocation); }
    // Start/end and redelivery share a server-generated UUID. They represent
    // one provider invocation; an application retry gets another UUID.
    invocation[entry.code === 'inference_started' ? 'started' : 'finished'] = meta;
    if (meta.attempt_ref) attemptFor(meta.attempt_ref, entry.ts);
  }
  const all = [...invocations.values()], attributed = [], unattributed = [], byAgent = new Map();
  for (const invocation of all) {
    const meta = invocation.finished || invocation.started;
    if (meta.attempt_ref) {
      attributed.push(invocation);
      attempts.get(meta.attempt_ref).invocations.push(invocation);
    } else unattributed.push(invocation);
    const role = meta.agent_role || 'unknown';
    if (!byAgent.has(role)) byAgent.set(role, []);
    byAgent.get(role).push(invocation);
  }
  const byStatus = { completed: [], abandoned: [], active: [] };
  const rows = [...attempts.values()].map(attempt => {
    const status = attempt.completed ? 'completed' : until - Date.parse(attempt.last_seen) >= abandonAfterMs ? 'abandoned' : 'active';
    byStatus[status].push(...attempt.invocations);
    return { attempt_ref: attempt.attempt_ref, status, first_seen: attempt.first_seen, last_seen: attempt.last_seen,
      ...summarize(attempt.invocations, rateCard) };
  });
  const lessons = summarize(attributed, rateCard), completed = rows.filter(x => x.status === 'completed').length;
  const authoringRoles = new Set(['lesson-creator', 'lesson-extractor', 'knowledge-base-editor', 'knowledge-base-extractor', 'admin-test']);
  const missingContext = unattributed.filter(call => !authoringRoles.has((call.finished || call.started).agent_role)).length;
  return { schema_version: 1, since: scan.since, until: scan.until, window_only: true,
    rate_card_version: rateCard.version, abandonment_after_ms: abandonAfterMs, ttft_scope: 'server_provider',
    total: summarize(all, rateCard), lessons, unattributed: summarize(unattributed, rateCard),
    completed_attempts: completed,
    missing_lesson_context_invocations: missingContext, lesson_attribution_complete: missingContext === 0,
    cost_per_completed_lesson_usd: completed && lessons.estimated_cost_usd !== null ? money(lessons.estimated_cost_usd / completed) : null,
    cost_per_completed_lesson_complete: lessons.cost_complete && completed > 0 && missingContext === 0,
    by_agent: Object.fromEntries([...byAgent].map(([role, calls]) => [role, summarize(calls, rateCard)])),
    by_status: Object.fromEntries(Object.entries(byStatus).map(([status, calls]) => [status, summarize(calls, rateCard)])), attempts: rows };
}
