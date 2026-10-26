// Isolated local-only fixture: real auth, profile and SQLite persistence;
// deterministic provider/link responses with the real coach and save routes; no .env or external inference.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const { default: db } = await import(join(root, 'server/src/lib/db.js'));
const { hashPassword } = await import(join(root, 'server/src/lib/password.js'));
const { seedDefaultContent } = await import(join(root, 'server/src/lib/seed.js'));
await seedDefaultContent();
for (const id of ['a', 'b', 'admin']) {
  await db.createUser({ userId: id, email: `learner-${id}@example.test`, username: `learner-${id}`, name: `Learner ${id}`,
    role: id === 'admin' ? 'admin' : 'user', passwordHash: await hashPassword(process.env.PLATO_TEST_PASSWORD) });
  await db.putSyncData(id, 'preferences', { name: `Learner ${id}` }, 0);
  await db.putSyncData(id, 'profile', { name: `Learner ${id}`, activeLessons: ['feedback'], masteredLessons: [] }, 0);
  await db.putSyncData(id, 'profileSummary', 'Synthetic learner practicing feedback.', 0);
}
const names = ['Give constructive feedback', 'Practice giving thoughtful, specific, actionable feedback across a challenging workplace conversation with several participants', 'Completed communication practice', ...Array.from({ length: 11 }, (_, i) => `Practice communication ${i + 4}`)];
for (const [index, name] of names.entries()) {
  const id = index === 0 ? 'feedback' : index === 1 ? 'long-title' : index === 2 ? 'completed' : `practice-${index + 1}`;
  await db.putSyncData('_system', `lesson:${id}`, { name, status: 'public', course: 'communication', markdown: `# ${name}\n\n## Description\nPractice giving clear and useful feedback.\n\n## Exemplar\nWrite an observation and a practical next step.\n\n## Learning Objectives\n- Separate observations from assumptions.\n- Request a concrete next step.\n\n## Coach Instructions\nInvite the learner to draft constructive feedback.` }, 0);
  for (const owner of ['a', 'b']) {
    await db.putSyncData(owner, `lessonKB:${id}`, { lessonId: id, name, status: index === 2 ? 'completed' : 'learning', progress: index === 2 ? 10 : 3,
      startedAt: 1000, activitiesCompleted: 1, exemplar: 'Write actionable feedback.', learningObjectives: ['State an observation.'] }, 0);
    await db.putSyncData(owner, `messages:${id}`, [{ id: `${id}:guide`, role: 'assistant', msgType: 'guide', phase: 'learning', content: 'Draft a feedback message with one observation and a practical next step.', timestamp: 1000 }], 0);
  }
}
await db.putSyncData('_system', 'course:communication', { name: 'Communication, collaboration and thoughtful feedback across distributed teams' }, 0);
const settings = await db.getSyncData('_system', 'settings');
await db.putSyncData('_system', 'settings', { ...settings.data, classroomName: 'Learner regression classroom', userFields: [
  { id: 'goal', label: 'Learning goal', type: 'text', required: false },
  { id: 'phone', label: 'Phone', type: 'phone', required: false },
  { id: 'team', label: 'Team', type: 'dropdown', options: ['Learning team', 'Practice team'], required: false },
] }, settings.version);

const app = new Hono();
const { default: ai } = await import(join(root, 'server/src/lib/ai-provider.js'));
ai.invoke = async () => ({ content: [{ type: 'text', text: JSON.stringify({ changed: false }) }] });
ai.invokeStream = async function* () {
  yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Add the impact on the team and propose a practical next step.\n[PROGRESS: 4]\n[KB_UPDATE: {"responseType":"work","insights":[],"learnerPosition":"A next step is needed.","evidence":[],"exemplarEvidence":{"status":"missing","observation":"","sourceIds":[]}}]' } };
};
app.route('/', (await import(join(root, 'server/src/routes/ai.js'))).default);
app.post('/v1/links/fetch', c => c.json({ url: 'https://example.test/reference', title: 'Test reference', siteName: 'Example', text: 'A synthetic reference for the coach.' }));
app.get('/v1/waitlist', c => c.json({ open: false }));
for (const file of ['health', 'auth', 'me', 'sync', 'content']) app.route('/', (await import(join(root, `server/src/routes/${file}.js`))).default);
const assets = process.env.PLATO_TEST_CLIENT_DIST || join(root, 'client/dist');
app.use('*', serveStatic({ root: assets }));
app.get('*', serveStatic({ path: join(assets, 'index.html') }));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.PORT) });
console.log('Learner regression fixture ready');
process.on('SIGTERM', () => server.close(() => process.exit()));
