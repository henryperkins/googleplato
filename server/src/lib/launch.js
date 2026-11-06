import { setTimeout as delay } from 'node:timers/promises';
import { runMigrations } from './migrations.js';
import { runDueJobs } from './schedule.js';
import './learner-emails.js';
import './messages.js';
import { logger } from './logger.js';

// Production must become ready with migrated durable storage. A bounded race
// would leave migrations running after readiness and hide persistent failures.
export async function initializeLaunch({ budgetMs = 20000, migrate = runMigrations } = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const outcome = await migrate();
    if (outcome.ran.some(({ result }) => result.errors)) throw new Error('Launch migrations failed');
    if (!['locked', 'lost_race'].includes(outcome.skipped)) return outcome;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for launch migrations');
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

export async function scheduleLaunchJobs(c, next) {
  try { await runDueJobs(); }
  catch (error) { logger.error('schedule_check_failed', { error: error?.message }); }
  await next();
}
