import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const values = new Map();
globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
globalThis.sessionStorage = { getItem: () => null };
const storage = await import('../js/storage.js');
const auth = await import('../js/auth.js');
const profile = await import('../src/lib/profileQueue.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const initial = { name: 'Old session', learnerNotes: [{ text: 'original', at: 1 }] };
let writes, models, loginCount, waitForBody, modelResult;
beforeEach(async () => {
  await profile.queueProfileUpdate(async () => {});
  writes = []; models = 0; loginCount = 0; waitForBody = null; modelResult = { changed: false };
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/v1/auth/login') { loginCount++; return Response.json({ accessToken: `access-${loginCount}`, refreshToken: `refresh-${loginCount}`, user: { userId: 'a' } }); }
    if (url === '/v1/auth/logout') return Response.json({ ok: true });
    if (url === '/v1/sync/status') return Response.json({ protocol: '1', epoch: 'profile-session' });
    if (url.startsWith('/v1/prompts/')) return Response.json({ content: 'Fixture profile prompt' });
    if (url === '/v1/ai/messages') { models++; return Response.json({ content: [{ type: 'text', text: JSON.stringify(modelResult) }] }); }
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      writes.push({ url, ...body });
      if (waitForBody && waitForBody(writes.at(-1))) {
        return { ok: true, status: 200, json: () => { waitForBody.started.resolve(); return waitForBody.pending.promise; } };
      }
      return Response.json({ version: body.version + 1 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  await auth.login('a@example.test', 'synthetic');
  storage.clearCache();
  storage._populateCache('profile', structuredClone(initial), 1);
  storage._populateCache('profileSummary', 'Old summary', 1);
  storage._populateCache('preferences', { name: 'Old', sendKey: 'mod-enter' }, 1);
});
function hold(predicate) {
  const started = deferred(), pending = deferred();
  waitForBody = Object.assign(predicate, { pending, started });
  return { started: started.promise, resolve: pending.resolve };
}
async function sameUserNewLogin() {
  await auth.logout(); await auth.login('a@example.test', 'synthetic');
  storage.clearCache();
  storage._populateCache('profile', { name: 'New session', learnerNotes: [{ text: 'newer note', at: 3 }] }, 3);
  storage._populateCache('profileSummary', 'New summary', 3);
  storage._populateCache('preferences', { name: 'New', sendKey: 'enter', anotherSetting: true }, 3);
}
for (const kind of ['add', 'remove', 'preferences']) test(`${kind}: delayed acknowledged PUT cannot publish into a later login for the same user`, async () => {
  const key = kind === 'preferences' ? 'preferences' : 'profile';
  const body = hold(write => write.url === `/v1/sync/${key}` && write.version === 1);
  const pending = kind === 'add' ? profile.addLearnerNote('old submitted note', { expectedUserId: 'a', at: 2 })
    : kind === 'remove' ? profile.removeLearnerNote(initial.learnerNotes[0], { expectedUserId: 'a' })
      : storage.savePreferences({ name: 'Old', sendKey: 'mod-enter' }, { expectedUserId: 'a' });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await body.started; await sameUserNewLogin(); body.resolve({ version: 2 });
  const result = await outcome;
  if (kind !== 'preferences') assert.ok(result.error, 'queued follow-up must reject the obsolete session');
  else assert.equal(result.error, undefined, 'a valid server acknowledgement must not be described as an unsaved write');
  assert.equal(models, 0, 'the old note acknowledgement cannot start optional inference');
  assert.equal((await storage.getLearnerProfile()).name, 'New session');
  assert.deepEqual(await storage.getPreferences(), { name: 'New', sendKey: 'enter', anotherSetting: true });
  waitForBody = null;
  if (kind === 'preferences') await storage.savePreferences({ name: 'Newest' }, { expectedUserId: 'a' });
  else await storage.saveLearnerProfile({ name: 'Newest' }, { expectedUserId: 'a' });
  assert.equal(writes.at(-1).version, 3, 'the delayed acknowledgement cannot replace the new cache version');
});
test('same-session token refresh still publishes an acknowledged note and runs its optional model', async () => {
  const body = hold(write => write.url === '/v1/sync/profile');
  const pending = profile.addLearnerNote('current note', { expectedUserId: 'a', at: 2 });
  await body.started;
  await storage.saveAuthTokens({ accessToken: 'refreshed', refreshToken: 'refreshed-r' }, await storage.getAuthTokens());
  body.resolve({ version: 2 });
  const result = await pending;
  assert.equal(result.noteSaved, true);
  assert.equal(models, 1);
  assert.equal((await storage.getLearnerProfile()).learnerNotes.at(-1).text, 'current note');
});
test('a delayed model-profile acknowledgement cannot publish or continue into a summary write in a new session', async () => {
  modelResult = { profile: { goal: 'Old model goal' }, summary: 'Old model summary' };
  const body = hold(write => write.url === '/v1/sync/profile' && write.version === 2);
  const pending = profile.addLearnerNote('old correction', { expectedUserId: 'a', at: 2 });
  const outcome = pending.then(() => null, error => error);
  await body.started; await sameUserNewLogin(); body.resolve({ version: 3 });
  assert.ok(await outcome);
  assert.equal(models, 1);
  assert.equal(writes.filter(write => write.url === '/v1/sync/profileSummary').length, 0);
  assert.equal((await storage.getLearnerProfile()).name, 'New session');
  assert.equal(await storage.getLearnerProfileSummary(), 'New summary');
});
