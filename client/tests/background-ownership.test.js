import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
globalThis.sessionStorage = { getItem: () => null };
const session = id => localStorage.setItem('plato_auth', JSON.stringify({ accessToken: `access-${id}`, refreshToken: `refresh-${id}`, user: { userId: id } }));
const json = body => Response.json(body);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const storage = await import('../js/storage.js');
const profile = await import('../src/lib/profileQueue.js');
const course = await import('../src/lib/courseProgressQueue.js');
let writes;
const lesson = { lessonId: 'lesson', name: 'Lesson', course: { id: 'course', name: 'Course' } };
const kb = { name: 'Lesson', insights: [], activitiesCompleted: 1 };

function switchAccount(id) {
  session(id);
  storage.clearCache();
  storage._populateCache('profile', { name: id === 'a' ? 'Alice' : 'Bob', goal: `${id} private goal` }, 1);
  storage._populateCache('profileSummary', `${id} summary`, 1);
  storage._populateCache('courseProgress:course', { summary: `${id} course`, completedLessonIds: [] }, 1);
}

beforeEach(() => {
  writes = [];
  switchAccount('a');
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/v1/sync/status') return json({ protocol: '1', epoch: 'background-owner' });
    if (url.startsWith('/v1/prompts/')) return json({ content: 'Fixture prompt' });
    if (url === '/v1/lessons') return json([]);
    if (url === '/v1/sync') return json({});
    if (url === '/v1/sync/profile' && options.method !== 'PUT') return json({ data: null, version: 0 });
    if (options.method === 'PUT') {
      writes.push({ url, token: new Headers(options.headers).get('Authorization'), data: JSON.parse(options.body).data });
      return json({ version: JSON.parse(options.body).version + 1 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
});

for (const kind of ['observation', 'completion', 'course']) {
  test(`${kind} enrichment cannot cross accounts while the model body is pending`, async () => {
    const baseFetch = globalThis.fetch;
    const body = deferred(), started = deferred();
    globalThis.fetch = async (url, options) => url === '/v1/ai/messages'
      ? { ok: true, status: 200, json: () => { started.resolve(); return body.promise; } }
      : baseFetch(url, options);
    if (kind === 'observation') profile.updateProfileFromObservation(kb, 'A observation', { userId: 'a' });
    else if (kind === 'completion') profile.updateProfileOnCompletionInBackground(kb, lesson, { userId: 'a' });
    else course.updateCourseProgressOnCompletionInBackground(kb, lesson, { userId: 'a' });
    await started.promise;
    switchAccount('b');
    body.resolve({ content: [{ type: 'text', text: JSON.stringify({ changed: true, profile: { goal: 'Alice secret' }, summary: 'Alice summary' }) }] });
    await profile.queueProfileUpdate(async () => {});
    await course.queueCourseProgressUpdate(async () => {});
    assert.deepEqual(writes, []);
    assert.equal((await storage.getLearnerProfile()).name, 'Bob');
    assert.equal((await storage.getCourseProgress('course')).summary, 'b course');
  });
}

test('queued enrichment checks its owner before reading context or invoking a model', async () => {
  const barrier = deferred();
  const queued = profile.queueProfileUpdate(() => barrier.promise);
  profile.updateProfileOnCompletionInBackground(kb, lesson, { userId: 'a' });
  switchAccount('b');
  storage.clearCache();
  let modelCalls = 0;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/v1/ai/messages') { modelCalls++; return json({ content: [{ type: 'text', text: '{"changed":false}' }] }); }
    return baseFetch(url, options);
  };
  barrier.resolve();
  await queued;
  await profile.queueProfileUpdate(async () => {});
  assert.equal(modelCalls, 0);
  assert.deepEqual(writes, []);
});

test('late owner-bound profile reads cannot populate the next account cache', async () => {
  storage.clearCache();
  const body = deferred(), started = deferred();
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => url === '/v1/sync/profile'
    ? { ok: true, status: 200, json: () => { started.resolve(); return body.promise; } }
    : baseFetch(url, options);
  const pending = profile.ensureProfileExists('', { expectedUserId: 'a' });
  const outcome = pending.catch(error => error);
  await started.promise;
  switchAccount('b');
  body.resolve({ data: { name: 'Alice' }, version: 2 });
  assert.ok((await outcome) instanceof Error);
  assert.equal((await storage.getLearnerProfile()).name, 'Bob');
  assert.deepEqual(writes, []);
});

test('same-owner completion still saves mastery and accepts a no-change model result', async () => {
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => url === '/v1/ai/messages'
    ? json({ content: [{ type: 'text', text: '{"changed":false}' }] }) : baseFetch(url, options);
  profile.updateProfileOnCompletionInBackground(kb, lesson, { userId: 'a' });
  await profile.queueProfileUpdate(async () => {});
  assert.deepEqual((await storage.getLearnerProfile()).masteredLessons, ['lesson']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].token, 'Bearer access-a');
});
