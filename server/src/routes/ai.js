import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { authenticate } from '../middleware/authenticate.js';
import { requireCurrentClient } from '../middleware/clientCompatibility.js';
import ai from '../lib/ai-provider.js';
import { classifyAiError, aiErrorStatus } from '../lib/ai-errors.js';
import { inferenceContext } from '../lib/inference-telemetry.js';
import { generateCoachTurn, recoverCoachTurn } from '../lib/lesson-coaching.js';

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
  const report = error => error.status ? { code: 'coach_request_failed', error: error.message, status: error.status }
    : { ...classifyAiError(error), status: aiErrorStatus(classifyAiError(error).code) };
  if (!body.stream) {
    try { return c.json(await generateCoachTurn(c.get('userId'), c.req.param('lessonId'), body)); }
    catch (error) { const result = report(error); return c.json({ code: result.code, error: result.error || result.message }, result.status); }
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

aiRoute.post('/v1/ai/messages', async (c) => {
  const body = await c.req.json();
  const { model, max_tokens, system, messages, stream: isStream } = body;

  if (!model) return c.json({ error: 'model is required' }, 400);
  if (!messages || !Array.isArray(messages)) return c.json({ error: 'messages array is required' }, 400);

  // Reject messages with empty content — Bedrock returns ValidationException for these
  for (const msg of messages) {
    if (!msg.content || (typeof msg.content === 'string' && !msg.content.trim()) || (Array.isArray(msg.content) && msg.content.length === 0)) {
      return c.json({ error: 'messages must have non-empty content', code: 'empty_message' }, 400);
    }
  }

  const aiBody = {
    max_tokens: max_tokens || 1024,
    ...(system ? { system } : {}),
    messages,
  };
  const context = inferenceContext(c.get('userId'), body.telemetry);

  if (!isStream) {
    try {
      const responseBody = await ai.invoke(model, aiBody, { context });
      return c.json(responseBody);
    } catch (err) {
      const { code, message } = classifyAiError(err);
      return c.json({ code, error: message }, aiErrorStatus(code));
    }
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return stream(c, async (s) => {
    const controller = new AbortController();
    s.onAbort(() => controller.abort());
    try {
      for await (const event of ai.invokeStream(model, aiBody, { signal: controller.signal, context })) {
        if (s.aborted) break;
        await s.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (!s.aborted) await s.write('data: [DONE]\n\n');
    } catch (err) {
      if (s.aborted) return;
      // The shared provider records a content-free classified failure.
      // A stable code and a generic message, never the raw provider text,
      // which can include the AWS account ID and IAM role name.
      const { code, message } = classifyAiError(err);
      await s.write(`data: ${JSON.stringify({ type: 'error', error: { code, message } })}\n\n`);
    } finally {
      controller.abort();
    }
  });
});

export default aiRoute;
// Keep backward compat — imported as `ai` in index.js
