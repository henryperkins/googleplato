import { Hono } from 'hono';
import { handle, streamHandle } from 'hono/aws-lambda';
import { cors } from 'hono/cors';
import { CLIENT_COMPATIBILITY_HEADERS, clientCompatibility } from './middleware/clientCompatibility.js';
import health from './routes/health.js';
import auth from './routes/auth.js';
import me from './routes/me.js';
import admin, { recomputeAndCacheLessonStats } from './routes/admin.js';
import sync from './routes/sync.js';
import clientEvents from './routes/client-events.js';
import ai from './routes/ai.js';
import content from './routes/content.js';
import links from './routes/links.js';
import waitlist from './routes/waitlist.js';
import app from './routes/app.js';
import db from './lib/db.js';
import { generateUserId } from './lib/crypto.js';
import { hashPassword } from './lib/password.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './config.js';
import { initializeLaunch, scheduleLaunchJobs } from './lib/launch.js';
import { isJobEvent, runJob } from './lib/jobs.js';
import { viewAsReadOnly } from './middleware/viewAsReadOnly.js';
import unsubscribe from './routes/unsubscribe.js';
import { seedDefaultContent } from './lib/seed.js';
import { logger } from './lib/logger.js';
import { pluginRegistry } from './lib/plugins/registry.js';
import { makePluginDispatcher, makeSlackLegacyShim } from './lib/plugins/dispatcher.js';
import { isSelfInvokeEvent } from './lib/lesson-stats-cache.js';

clientCompatibility();

// Lambda-only fail-fast, mirroring the production gates in server/start.js.
// SAM supplies these via SSM; silently falling back to the dev JWT secret
// would sign forgeable tokens. Gated on the Lambda runtime marker so local
// and test imports of this module (SQLite) are unaffected.
if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET === 'dev-secret-change-me') {
    throw new Error('Lambda requires a JWT_SECRET of at least 32 characters');
  }
  if (process.env.DB_BACKEND && !['postgres', 'dynamodb'].includes(process.env.DB_BACKEND)) {
    throw new Error('Lambda requires DB_BACKEND=postgres or dynamodb');
  }
  if (process.env.APP_URL && !process.env.APP_URL.startsWith('https://')) {
    throw new Error('Lambda requires an HTTPS APP_URL');
  }
}
// config.js has already captured the bootstrap credential; keep it out of
// the process environment that plugin code can read.
delete process.env.ADMIN_PASSWORD;

const server = new Hono();

server.use('*', cors({
  origin: process.env.APP_URL || '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Plato-View-As', ...CLIENT_COMPATIBILITY_HEADERS],
}));

// First-request initialization: admin bootstrap, content seeding
let initialization = null;
server.use('*', async (c, next) => {
  if (!initialization) {
    initialization = initializeServer().catch(error => {
      initialization = null;
      throw error;
    });
  }
  await initialization;
  await next();
});

async function initializeServer() {
  // Admin bootstrap
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    try {
      const count = await db.countUsers();
      if (count === 0) {
        const userId = generateUserId();
        const passwordHash = await hashPassword(ADMIN_PASSWORD);
        await db.createUser({
          userId,
          email: ADMIN_EMAIL.toLowerCase(),
          username: 'admin',
          passwordHash,
          name: 'Admin',
          role: 'admin',
        });
        console.log(`Admin bootstrapped: ${ADMIN_EMAIL}`);
      }
    } catch (err) {
      console.error('Admin bootstrap failed:', err.message);
    }
  }
  await initializeLaunch();
  // Routes are statically mounted below; registry boot populates dispatchers.
  const seeded = await seedDefaultContent();
  if (seeded > 0) console.log(`Seeded ${seeded} content item(s)`);
  await pluginRegistry.boot();
}

server.use('*', viewAsReadOnly);
server.use('*', scheduleLaunchJobs);
server.route('/', health);
server.route('/', auth);
server.route('/', me);
server.route('/', admin);
server.route('/', sync);
server.route('/', clientEvents);
server.route('/', ai);
server.route('/', content);
server.route('/', links);
server.route('/', waitlist);
server.route('/', unsubscribe);

// Plugin catch-all + legacy shim. See server/src/lib/plugins/dispatcher.js for
// the handler logic. Registered BEFORE `app` because app.js has a global SPA
// fallback (`app.get('*')`) that would otherwise swallow plugin GETs.
server.all('/v1/plugins/:pluginId/*', makePluginDispatcher(pluginRegistry));
server.all('/v1/admin/slack/*', makeSlackLegacyShim(pluginRegistry));

// SPA fallback last.
server.route('/', app);

server.notFound((c) => c.json({ error: 'Not found' }, 404));

server.onError((err, c) => {
  logger.error('unhandled_error', {
    path: c.req.path,
    method: c.req.method,
    error: err?.message || String(err),
    stack: err?.stack,
  });
  return c.json({ error: 'Internal server error' }, 500);
});

// API Gateway handler (buffered — used by admin dashboard).
// Wrapped to also handle self-invoke events for async dashboard-stats refresh.
const _httpHandler = handle(server);
export const handler = async (event, context) => {
  if (isJobEvent(event)) return runJob(event.job, event.payload);
  if (isSelfInvokeEvent(event)) {
    try {
      await recomputeAndCacheLessonStats();
      logger.warn('stats_async_refresh_completed');
      return { ok: true };
    } catch (err) {
      logger.error('stats_async_refresh_failed', { error: err?.message || String(err) });
      throw err;
    }
  }
  return _httpHandler(event, context);
};

// Function URL handler (streaming SSE responses)
export const streamHandler = streamHandle(server);
