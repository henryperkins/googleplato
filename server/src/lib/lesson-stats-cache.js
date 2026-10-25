// Stale-while-revalidate cache for the admin dashboard's lesson stats.
//
// The /v1/admin/stats/lessons aggregation walks every user × every sync-data
// item — costly to recompute on every dashboard load. The data tolerates
// minutes of lag (lastActiveAt updates lag on the same order), so we cache
// the result in `_system:stats:lessons` and serve stale-while-revalidate:
//
//   age < FRESH_TTL_MS  -> serve cached, no recompute
//   age < MAX_AGE_MS    -> serve cached + refresh (see below)
//   else                -> recompute synchronously, write back
//
// Refresh in the stale window depends on the runtime:
//   - Lambda: a separate self-invocation (InvocationType: 'Event'). The
//     handler at server/src/index.js detects the payload and refreshes.
//     The SDK client is imported lazily so non-Lambda runtimes (Cloud Run,
//     local dev) never pay to load it.
//   - Everywhere else: work after the response isn't reliable on Cloud Run
//     (cpu-throttling: true), so the request starts — or joins — a single-
//     flight recompute and awaits it for up to 2 s. Fresh result if it
//     finishes, the stale cache otherwise; the flight keeps running so the
//     next stale read can join it instead of starting a second recompute.

import { logger } from './logger.js';

export const FRESH_TTL_MS = 10 * 60 * 1000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SELF_INVOKE_MARKER = 'refreshLessonStats';

let _lambda = null;
async function getLambdaClient() {
  if (!_lambda) {
    const { LambdaClient } = await import('@aws-sdk/client-lambda');
    _lambda = new LambdaClient({});
  }
  return _lambda;
}

export function isSelfInvokeEvent(event) {
  return event && typeof event === 'object' && event.__platoInternal === SELF_INVOKE_MARKER;
}

export function cacheAgeMs(cached) {
  const computedAt = cached?.data?.computedAt;
  if (!computedAt) return Infinity;
  const ms = Date.parse(computedAt);
  if (!Number.isFinite(ms)) return Infinity;
  return Date.now() - ms;
}

export function classifyCache(cached) {
  const age = cacheAgeMs(cached);
  if (age < FRESH_TTL_MS) return 'fresh';
  if (age < MAX_AGE_MS) return 'stale';
  return 'expired';
}

export async function kickoffAsyncRefresh() {
  const fnName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!fnName) return; // local dev / tests / Cloud Run (single-flight below)
  try {
    const { InvokeCommand } = await import('@aws-sdk/client-lambda');
    const lambda = await getLambdaClient();
    await lambda.send(new InvokeCommand({
      FunctionName: fnName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ __platoInternal: SELF_INVOKE_MARKER })),
    }));
    logger.warn('stats_async_refresh_invoked', { function: fnName });
  } catch (err) {
    logger.error('stats_async_refresh_invoke_failed', { error: err?.message || String(err) });
  }
}

// Single-flight stale refresh for non-Lambda runtimes. Returns the fresh
// { computedAt, stats } when the shared recompute finishes within
// `timeoutMs`, or null when it doesn't (or fails) so callers serve stale.
let _inFlightRefresh = null;

export async function refreshStaleLessonStats(recompute, timeoutMs = 2000) {
  if (!_inFlightRefresh) {
    _inFlightRefresh = (async () => {
      try {
        return await recompute();
      } finally {
        _inFlightRefresh = null;
      }
    })();
    // A failed flight must not surface as an unhandled rejection when no
    // caller is still awaiting it; awaiting callers still see the failure
    // through the raced promise below and fall back to stale.
    _inFlightRefresh.catch(() => {});
  }
  let timer;
  try {
    return await Promise.race([
      _inFlightRefresh,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch (err) {
    logger.error('stats_async_refresh_failed', { error: err?.message || String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function _resetStaleRefreshForTests() {
  _inFlightRefresh = null;
}
