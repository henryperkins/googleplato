import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { authenticate } from '../middleware/authenticate.js';
import { requireCurrentClient } from '../middleware/clientCompatibility.js';
import ai from '../lib/ai-provider.js';
import { classifyAiError, aiErrorStatus } from '../lib/ai-errors.js';
import { inferenceContext } from '../lib/inference-telemetry.js';
import { generateCoachTurn, recoverCoachTurn } from '../lib/lesson-coaching.js';
import { MAX_BODY_BYTES, validateAiRequest } from '../lib/ai-limits.js';

// Busy, not broken: a typed error carries how long to wait (lib/ai-errors.js).
const retryFields = ({ retryAfterMs }) => (retryAfterMs ? { retryAfterMs } : {});
function retryHeader(c, { retryAfterMs }) {
  if (retryAfterMs) c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
}

const aiRoute = new Hono();

aiRoute.use('/v1/ai/*', authenticate);
aiRoute.use('/v1/ai/*', requireCurrentClient);

aiRoute.get('/v1/ai/coach/:lessonId', async (c) => {
  if (c.req.query('asUserId')) return c.json({ error: 'Coaching is unavailable while viewing another user.' }, 403);
  c.header('Cache-Control', 'no-store');
  const turn = await recoverCoachTurn(c.get('userId'), c.req.param('lessonId'), c.req.query('turnId'));
  return turn ? c.json(turn) : c.json({ error: 'No generated reply is available.' }, 404);
});

aiRoute.post('/v1/ai/coach/:lessonId', async (c) => {
  if (c.req.query('asUserId')) return c.json({ error: 'Coaching is unavailable while viewing another user.' }, 403);
  const body = await c.req.json();
  const report = error => error.status ? { code: error.code === 'coach_response_truncated' ? error.code : 'coach_request_failed', error: error.message, status: error.status }
    : { ...classifyAiError(error), status: aiErrorStatus(classifyAiError(error).code) };
  if (!body.stream) {
    try { return c.json(await generateCoachTurn(c.get('userId'), c.req.param('lessonId'), body)); }
    catch (error) {
      const result = report(error);
      retryHeader(c, result);
      return c.json({ code: result.code, error: result.error || result.message, ...retryFields(result) }, result.status);
    }
  }
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-store');
  return stream(c, async s => {
    // Finish and retain the bounded generation even if the browser disappears.
    // Recovery is a GET; neither reload nor save invokes the provider again.
    try {
      const turn = await generateCoachTurn(c.get('userId'), c.req.param('lessonId'), body,
        text => s.aborted ? undefined : s.write(`data: ${JSON.stringify({ type: 'coach_text', text })}\n\n`).catch(() => {}));
      if (!s.aborted) await s.write(`data: ${JSON.stringify({ type: 'coach_turn', turn })}\n\n`);
    } catch (error) {
      if (!s.aborted) await s.write(`data: ${JSON.stringify({ type: 'error', ...report(error) })}\n\n`);
    }
  });
});

aiRoute.post('/v1/ai/messages', bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: c => c.json({ error: `Request is too large (over ${MAX_BODY_BYTES / 1024 / 1024} MB)` }, 413),
}), async (c) => {
  const body = await c.req.json().catch(() => null);
  // Only plato's model, and calls the size of what plato's agents send (lib/ai-limits.js).
  const checked = validateAiRequest(body);
  if (checked.error) return c.json({ error: checked.error, ...(checked.code ? { code: checked.code } : {}) }, 400);
  const { aiBody } = checked;
  const context = inferenceContext(c.get('userId'), body.telemetry);
  const fail = (err) => {
    const { code, message, retryAfterMs } = classifyAiError(err);
    retryHeader(c, { retryAfterMs });
    return c.json({ code, error: message, ...retryFields({ retryAfterMs }) }, aiErrorStatus(code));
  };

  if (!checked.stream) {
    try { return c.json(await ai.invoke(body.model, aiBody, { context })); }
    catch (err) { return fail(err); }
  }

  // Wait for the provider's first event before committing the SSE headers, so
  // a throttle or outage at the start is a real 429/503 the client can back
  // off from, not a 200 followed by an error event (upstream #516).
  const controller = new AbortController();
  const events = ai.invokeStream(body.model, aiBody, { signal: controller.signal, context })[Symbol.asyncIterator]();
  let first;
  try { first = await events.next(); }
  catch (err) { controller.abort(); return fail(err); }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return stream(c, async (s) => {
    s.onAbort(() => controller.abort());
    try {
      for (let next = first; !next.done; next = await events.next()) {
        if (s.aborted) break;
        await s.write(`data: ${JSON.stringify(next.value)}\n\n`);
      }
      if (!s.aborted) await s.write('data: [DONE]\n\n');
    } catch (err) {
      if (s.aborted) return;
      // The shared provider records a content-free classified failure.
      // A stable code and a generic message, never the raw provider text,
      // which can include the AWS account ID and IAM role name.
      const { code, message, retryAfterMs } = classifyAiError(err);
      await s.write(`data: ${JSON.stringify({ type: 'error', error: { code, message, ...retryFields({ retryAfterMs }) } })}\n\n`);
    } finally {
      controller.abort();
      await events.return?.(); // releases this user's slot if the stream stopped early
    }
  });
});

export default aiRoute;
// Keep backward compat — imported as `ai` in index.js
