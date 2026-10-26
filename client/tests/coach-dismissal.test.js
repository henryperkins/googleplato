import { test } from 'node:test';
import assert from 'node:assert/strict';

const disk = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
globalThis.localStorage = disk();
globalThis.sessionStorage = disk();
localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'token', user: { userId: 'a' } }));
const { generatedTurns } = await import('../src/lib/generatedTurns.js');
const { discardLessonReply, resumeLesson } = await import('../src/lib/lessonEngine.js');
const kb = { lessonId: 'lesson', startedAt: 100, status: 'active', progress: 3 };
const opening = { id: 'opening', role: 'assistant', content: 'Opening' };
const base = { generation: null, messages: { data: [opening], version: 1 }, lessonKB: { data: kb, version: 1 } };
const turn = { userId: 'a', lessonId: 'lesson', turnId: 'pending', base,
  messages: [{ id: 'pending:0', role: 'user', content: 'My response' }, { id: 'pending:1', role: 'assistant', content: 'Unsaved reply' }], lessonKB: kb, phase: 'learning' };
const current = { generation: null, messages: { data: [opening, { id: 'other', role: 'assistant', content: 'Saved elsewhere' }], version: 2 }, lessonKB: { data: kb, version: 2 } };

test('loading the saved conversation does not immediately recover its discarded conflicting reply', async () => {
  globalThis.fetch = async url => {
    if (url === '/v1/sync/status') return Response.json({ protocol: '1', epoch: 'dismissal' });
    if (url.startsWith('/v1/ai/coach/')) return Response.json(turn);
    if (url === '/v1/sync/lesson-turn/lesson') return Response.json(current);
    throw new Error(`Unexpected request: ${url}`);
  };
  generatedTurns.stage(turn);
  await discardLessonReply('lesson');
  const resumed = await resumeLesson('lesson');
  assert.deepEqual(resumed.messages, current.messages.data);
  assert.notEqual(resumed.persistence?.status, 'pending');
  assert.equal(generatedTurns.read('a', 'lesson'), null);
});
