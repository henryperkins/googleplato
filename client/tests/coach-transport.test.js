import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: key => key === 'plato_auth' ? JSON.stringify({ accessToken: 'token', user: { userId: 'u' } }) : null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem: () => null };
test('split streaming frames retain the exact signed turn and never save partial text as a turn', async () => {
  const api = await import('../js/coachTransport.js').catch(() => ({}));
  assert.equal(typeof api.requestCoachTurn, 'function');
  const turn = { userId: 'u', lessonId: 'l', turnId: 't', base: {}, messages: [{ content: 'Reply' }], lessonKB: {}, receipt: 'v1.signed' };
  const frames = `data: ${JSON.stringify({ type: 'coach_text', text: 'Reply' })}\n\ndata: ${JSON.stringify({ type: 'coach_turn', turn })}\n\n`;
  globalThis.fetch = async url => url.endsWith('/v1/sync/status') ? new Response(JSON.stringify({ protocol: '1', epoch: 'test' }), { headers: { 'content-type': 'application/json' } }) : new Response(new ReadableStream({ start(controller) { for (let i = 0; i < frames.length; i += 3) controller.enqueue(new TextEncoder().encode(frames.slice(i, i + 3))); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const seen = [];
  assert.deepEqual(await api.requestCoachTurn('l', { turnId: 't' }, text => seen.push(text), 'u'), turn);
  assert.deepEqual(seen, ['Reply']);
  globalThis.fetch = async url => url.endsWith('/v1/sync/status') ? new Response(JSON.stringify({ protocol: '1', epoch: 'test' }), { headers: { 'content-type': 'application/json' } }) : new Response('data: {"type":"coach_text","text":"Partial"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(api.requestCoachTurn('l', { turnId: 't' }, () => {}, 'u'), /incomplete/i);
});

test('an empty server recovery response is drained before returning to the lesson', async () => {
  const { recoverCoachTurn } = await import('../js/coachTransport.js');
  const response = Response.json({ error: 'No generated reply is available.' }, { status: 404 });
  globalThis.fetch = async url => url.endsWith('/v1/sync/status') ? Response.json({ protocol: '1', epoch: 'test' }) : response;
  assert.equal(await recoverCoachTurn('l', 'u'), null);
  assert.equal(response.bodyUsed, true);
});
