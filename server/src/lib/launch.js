import { setTimeout as delay } from 'node:timers/promises';
import { runMigrations, incompleteMigrations, createMigrationOwner } from './migrations.js';
import { runDueJobs } from './schedule.js';
import './learner-emails.js';
import './messages.js';
import { logger } from './logger.js';

const processMigrationOwner = createMigrationOwner();

// Production must become ready with migrated durable storage. A bounded race
// would leave migrations running after readiness and hide persistent failures.
export async function initializeLaunch({ budgetMs = 20000, migrate = runMigrations } = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const outcome = await migrate({ owner: processMigrationOwner });
    if (!['locked', 'lost_race'].includes(outcome?.skipped)) {
      const incomplete = incompleteMigrations(outcome);
      if (incomplete) throw new Error(`Launch migrations failed: ${incomplete}`);
      return outcome;
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for launch migrations');
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

export async function scheduleLaunchJobs(c, next) {
  try { await runDueJobs(); }
  catch (error) { logger.error('schedule_check_failed', { error: error?.message }); }
  await next();
}
