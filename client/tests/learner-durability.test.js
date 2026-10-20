import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function browserStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), clear: () => values.clear() };
}
globalThis.localStorage = browserStorage();
globalThis.sessionStorage = browserStorage();
const storage = await import('../js/storage.js');
const engine = await import('../src/lib/lessonEngine.js');
const { queueProfileUpdate } = await import('../src/lib/profileQueue.js');
const { queueCourseProgressUpdate } = await import('../src/lib/courseProgressQueue.js');
const records = new Map();
let mode, aiCalls, commits, coachText;
const lesson = { lessonId: 'lesson-1', name: 'A lesson', exemplar: 'Explain the idea', learningObjectives: ['Explain'], markdown: '# Lesson' };
const initialKB = { lessonId: 'lesson-1', name: lesson.name, startedAt: 100, progress: 2, status: 'learning', activitiesCompleted: 1, insights: [] };
const opening = { id: 'opening:0', role: 'assistant', content: 'Tell me what you think.', timestamp: 100 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const snapshot = () => ({ generation: null, messages: records.get('messages:lesson-1') || { data: [], version: 0 }, lessonKB: records.get('lessonKB:lesson-1') || { data: null, version: 0 } });

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); records.clear(); storage.clearCache();
  // A different user per test also isolates the in-memory recovery journal.
  const userId = `usr_${crypto.randomUUID()}`;
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'token', refreshToken: 'refresh', user: { userId } }));
  records.set('lessonKB:lesson-1', { data: structuredClone(initialKB), version: 1 });
  records.set('messages:lesson-1', { data: [structuredClone(opening)], version: 1 });
  records.set('profile', { data: { name: 'Learner', masteredLessons: [], activeLessons: [] }, version: 1 });
  mode = 'reject'; aiCalls = 0; commits = 0; coachText = 'Keep this useful feedback.\n[PROGRESS: 6]';
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path.startsWith('/v1/prompts/')) return json({ content: path.split('/').at(-1) });
    if (path === '/v1/knowledge-base') return json({ content: '' });
    if (path === '/v1/lessons') return json([]);
    if (path === '/v1/sync/lesson-started') return json({ enrichments: [] });
    if (path === '/v1/ai/messages') {
      aiCalls += 1;
      const body = JSON.parse(options.body);
      const text = body.system === 'lesson-owner' ? JSON.stringify({ exemplar: 'Explain', objectives: [{ objective: 'Explain', evidence: 'An explanation' }], learnerPosition: 'Starting', insights: [], activitiesCompleted: 0, status: 'learning' })
        : body.stream ? coachText : JSON.stringify({ profile: { name: 'Learner' }, summary: 'Learning' });
      return json({ content: [{ type: 'text', text }] });
    }
    if (path === '/v1/sync/lesson-turn/lesson-1') {
      if (options.method !== 'POST') return json(snapshot());
      commits += 1;
      const turn = JSON.parse(options.body);
      if (mode === 'reject' || mode === 'reject-turn') return json({ error: 'Save unavailable' }, 503);
      if (mode === 'conflict') return json({ error: 'Lesson changed elsewhere' }, 409);
      const state = snapshot();
      if (!turn.messages.every(message => state.messages.data.some(saved => saved.id === message.id))) {
        assert.deepEqual(turn.base, state, 'the retry must preserve its original base');
        records.set('messages:lesson-1', { data: [...state.messages.data, ...turn.messages], version: state.messages.version + 1 });
        records.set('lessonKB:lesson-1', { data: turn.lessonKB, version: state.lessonKB.version + 1 });
      }
      if (mode === 'lost-ack') { mode = 'ok'; throw new TypeError('Connection closed after commit'); }
      return json(snapshot());
    }
    const match = path.match(/^\/v1\/sync\/(.+)$/);
    if (match) {
      const key = decodeURIComponent(match[1]);
      if (options.method === 'PUT') {
        if (mode === 'reject' && /^(messages|lessonKB|screenshot):/.test(key)) return json({ error: 'Unavailable' }, 503);
        const body = JSON.parse(options.body);
        records.set(key, { data: body.data, version: body.version + 1 });
        return json({ version: body.version + 1 });
      }
      return json(records.get(key) || { data: null, version: 0 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
});

test('a failed save retains the generated reply and retries storage without another model call', async () => {
  const result = await engine.sendMessage('lesson-1', lesson, 'My answer', null, null, () => {});
  assert.equal(result.persistence?.status, 'pending');
  assert.equal(result.messages.at(-1).content, 'Keep this useful feedback.');
  assert.equal(records.get('lessonKB:lesson-1').data.progress, 2);
  assert.equal(aiCalls, 1);
  const turnIds = result.messages.map(message => message.id);
  storage.clearCache();
  const resumed = await engine.resumeLesson('lesson-1');
  assert.equal(resumed.persistence.status, 'pending');
  assert.equal(resumed.messages.at(-1).content, 'Keep this useful feedback.');
  mode = 'ok';
  const saved = await engine.retryLessonSave('lesson-1');
  assert.equal(saved.persistence.status, 'saved');
  assert.equal(aiCalls, 1);
  assert.deepEqual(records.get('messages:lesson-1').data.slice(-2).map(message => message.id), turnIds);
  assert.equal(records.get('lessonKB:lesson-1').data.progress, 6);
  assert.equal(records.get('lessonKB:lesson-1').data.activitiesCompleted, 2);
  await assert.rejects(() => engine.retryLessonSave('lesson-1'), /no retained reply/i);
});

test('a lost acknowledgement is reconciled without appending the reply or applying progress twice', async () => {
  mode = 'lost-ack';
  const result = await engine.sendMessage('lesson-1', lesson, 'My answer', null, null, () => {});
  assert.equal(result.persistence?.status, 'pending');
  const version = records.get('messages:lesson-1').version;
  await engine.retryLessonSave('lesson-1');
  assert.equal(records.get('messages:lesson-1').data.length, 3);
  assert.equal(records.get('messages:lesson-1').version, version);
  assert.equal(records.get('lessonKB:lesson-1').data.activitiesCompleted, 2);
  assert.equal(aiCalls, 1);
});

test('failed opening saves recover without re-running the lesson owner or opening coach', async () => {
  records.delete('messages:lesson-1'); records.delete('lessonKB:lesson-1');
  const result = await engine.startLesson('lesson-1', lesson, () => {});
  assert.equal(result.persistence?.status, 'pending');
  assert.equal(aiCalls, 2);
  mode = 'ok';
  await engine.retryLessonSave('lesson-1');
  assert.equal(aiCalls, 2);
  assert.equal(records.get('messages:lesson-1').data.length, 1);
});

test('a pending generated turn blocks normal Send and conflict retries keep the reply', async () => {
  await engine.sendMessage('lesson-1', lesson, 'My answer', null, null, () => {});
  await assert.rejects(() => engine.sendMessage('lesson-1', lesson, 'Again', null, null, () => {}), /save.*reply/i);
  mode = 'conflict';
  assert.equal((await engine.retryLessonSave('lesson-1')).persistence.status, 'conflict');
  assert.equal((await engine.resumeLesson('lesson-1')).messages.at(-1).content, 'Keep this useful feedback.');
  assert.equal(aiCalls, 1);
});

test('account switches and impersonation cannot retry another learner\'s retained turn', async () => {
  await engine.sendMessage('lesson-1', lesson, 'My answer', null, null, () => {});
  const auth = localStorage.getItem('plato_auth');
  localStorage.setItem('plato_auth', JSON.stringify({ accessToken: 'other', user: { userId: 'other' } }));
  const before = commits;
  await assert.rejects(() => engine.retryLessonSave('lesson-1'), /no retained reply/i);
  localStorage.setItem('plato_auth', auth);
  sessionStorage.setItem('plato_impersonation', JSON.stringify({ userId: 'other' }));
  await assert.rejects(() => engine.retryLessonSave('lesson-1'), /viewing as another user/);
  assert.equal(commits, before);
});

test('an image that cannot be saved prevents inference and preserves the editable submission', async () => {
  await assert.rejects(() => engine.sendMessage('lesson-1', lesson, 'My work', ['data:image/png;base64,YWJj'], null, () => {}), /image.*sav/i);
  assert.equal(aiCalls, 0);
});

test('failed completion never publishes enrichment and retry saves completion without any model calls', async () => {
  coachText = 'You have achieved the goal.\n[PROGRESS: 10]\n[PROFILE_UPDATE: {"observation":"Understands the idea"}]';
  const result = await engine.sendMessage('lesson-1', { ...lesson, course: { id: 'course-1', name: 'Course' } }, 'My answer', null, null, () => {});
  await queueProfileUpdate(() => {});
  await queueCourseProgressUpdate(() => {});
  assert.equal(result.persistence.status, 'pending');
  assert.equal(aiCalls, 1, 'an unsaved turn must not trigger profile or course models');
  assert.deepEqual(records.get('profile').data.masteredLessons, []);
  assert.equal(records.get('lessonKB:lesson-1').data.status, 'learning');
  mode = 'ok';
  const saved = await engine.retryLessonSave('lesson-1');
  await queueProfileUpdate(() => {});
  await queueCourseProgressUpdate(() => {});
  assert.equal(saved.persistence.status, 'saved');
  assert.equal(records.get('lessonKB:lesson-1').data.status, 'completed');
  assert.equal(aiCalls, 1, 'recovery must not call any model, including enrichment');
});

test('a fresh save returns the complete history, including another tab\'s saved exchange', async () => {
  const oldView = await engine.resumeLesson('lesson-1');
  assert.equal(oldView.messages.length, 1);
  const otherTurn = [{ id: 'other:0', role: 'user', content: 'From another tab' }, { id: 'other:1', role: 'assistant', content: 'Earlier feedback' }];
  records.set('messages:lesson-1', { data: [opening, ...otherTurn], version: 2 });
  mode = 'ok';
  const saved = await engine.sendMessage('lesson-1', lesson, 'Next answer', null, null, () => {});
  assert.equal(saved.conversation.length, 5);
  assert.deepEqual(saved.conversation.slice(1, 3), otherTurn);
  assert.equal(saved.conversation.at(-1).content, 'Keep this useful feedback.');
});

test('a stalled screenshot read cannot indefinitely hide a retained reply or save-only recovery', async () => {
  mode = 'reject-turn';
  await engine.sendMessage('lesson-1', lesson, 'My work', ['data:image/png;base64,YWJj'], null, () => {});
  storage.clearCache();
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, options) => decodeURIComponent(url).includes('/v1/sync/screenshot:')
    ? new Promise(() => {}) : fetch(url, options);
  const restored = await engine.resumeLesson('lesson-1');
  assert.equal(restored.persistence.status, 'pending');
  assert.equal(restored.messages.at(-1).content, 'Keep this useful feedback.');
  assert.equal(restored.messages.at(-2).metadata.imageKeys.length, 1);
  globalThis.fetch = fetch;
  mode = 'ok';
  assert.equal((await engine.retryLessonSave('lesson-1')).persistence.status, 'saved');
  assert.equal(aiCalls, 1);
});
