// Production HTTP entry point. Configuration must be present before importing
// routes; the SQLite development launcher deliberately sets different defaults.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { CLIENT_COMPATIBILITY_HEADERS, clientCompatibility } from './src/middleware/clientCompatibility.js';
import { installShutdown } from './src/lib/shutdown.js';

if (!['postgres', 'dynamodb'].includes(process.env.DB_BACKEND)) {
  throw new Error('Production requires DB_BACKEND=postgres or dynamodb');
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('Production requires a stable JWT_SECRET of at least 32 characters');
}
if (!process.env.APP_URL?.startsWith('https://')) {
  throw new Error('Production requires an HTTPS APP_URL');
}
clientCompatibility();

// Capture the one-time credential before config.js or plugins can retain it.
// Existing databases must not expose it either, even though bootstrap is skipped.
let bootstrapPassword = process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_PASSWORD;

const { default: db } = await import('./src/lib/db.js');
const { generateUserId } = await import('./src/lib/crypto.js');
const { hashPassword } = await import('./src/lib/password.js');
const { seedDefaultContent } = await import('./src/lib/seed.js');
const { pluginRegistry } = await import('./src/lib/plugins/registry.js');
const { makePluginDispatcher, makeSlackLegacyShim } = await import('./src/lib/plugins/dispatcher.js');
const { logger } = await import('./src/lib/logger.js');

// Do not expose an empty deployment's public setup endpoint before the operator
// account exists. Concurrent initial starts converge through unique email.
if (await db.countUsers() === 0) {
  const email = process.env.ADMIN_EMAIL;
  const password = bootstrapPassword;
  if (!email || !password) throw new Error('A clean database requires ADMIN_EMAIL and ADMIN_PASSWORD');
  try {
    await db.createUser({ userId: generateUserId(), email, username: 'admin',
      passwordHash: await hashPassword(password), name: 'Admin', role: 'admin' });
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException' || !(await db.getUserByEmail(email))) throw error;
  }
}
bootstrapPassword = undefined;
await seedDefaultContent();
await pluginRegistry.boot();

const app = new Hono();
app.use('*', cors({ origin: process.env.APP_URL,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', ...CLIENT_COMPATIBILITY_HEADERS],
  exposeHeaders: ['X-Plato-Revision', 'X-Plato-Commit'],
}));
app.use('*', async (c, next) => {
  c.header('X-Plato-Revision', process.env.K_REVISION || 'local');
  c.header('X-Plato-Commit', process.env.RELEASE_COMMIT || 'unknown');
  await next();
});
for (const name of ['health', 'auth', 'me', 'admin', 'sync', 'ai', 'content', 'links', 'waitlist']) {
  app.route('/', (await import(`./src/routes/${name}.js`)).default);
}
app.all('/v1/plugins/:pluginId/*', makePluginDispatcher(pluginRegistry));
app.all('/v1/admin/slack/*', makeSlackLegacyShim(pluginRegistry));
app.route('/', (await import('./src/routes/app.js')).default);
app.onError((error, c) => {
  logger.error('unhandled_error', { path: c.req.path, method: c.req.method, error: error.message });
  return c.json({ error: 'Internal server error' }, 500);
});

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT || 3000), hostname: '0.0.0.0' });
console.log(JSON.stringify({ event: 'server_ready', backend: process.env.DB_BACKEND,
  revision: process.env.K_REVISION, commit: process.env.RELEASE_COMMIT }));
installShutdown(server, async () => {
  if (process.env.DB_BACKEND === 'postgres') await (await import('./src/lib/db-postgres.js')).closeDatabase();
});
