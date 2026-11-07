#!/usr/bin/env node
/**
 * Report (and optionally run) pending data migrations — see src/lib/migrations.js.
 *
 * Read-only by default: prints what each pending migration WOULD change.
 * Migrations run automatically on cold start, so `--apply` is only for
 * rehearsals against a restored copy of prod.
 *
 * Usage (from server/):
 *   # local SQLite dev db
 *   DB_BACKEND=sqlite SQLITE_PATH=./data/plato-dev.db node scripts/migrate.js
 *
 *   # prod DynamoDB, read-only (needs AWS creds; e.g. AWS_PROFILE=dase)
 *   AWS_REGION=us-east-2 node scripts/migrate.js
 *
 *   # rehearsal against restored copies (table names are env-overridable)
 *   USERS_TABLE=plato-rehearsal-users SYNC_DATA_TABLE=plato-rehearsal-sync-data \
 *   INVITES_TABLE=plato-rehearsal-invites ... node scripts/migrate.js --apply
 */
import { pathToFileURL } from 'node:url';
import defaultDb from '../src/lib/db.js';
import { runMigrations, MIGRATIONS, incompleteMigrations, MigrationStateError } from '../src/lib/migrations.js';

export async function main({ db = defaultDb, argv = process.argv.slice(2), migrate = runMigrations } = {}) {
  const apply = argv.includes('--apply');
  try {
    const state = (await db.getSyncData('_system', 'migrations', { consistentRead: true }))?.data || { applied: {} };
    console.log(`Backend: ${process.env.DB_BACKEND || 'dynamodb'}  |  mode: ${apply ? 'APPLY' : 'dry run (no writes)'}`);
    for (const m of MIGRATIONS) console.log(`  ${state.applied?.[m.id] ? '✓ applied' : '· pending'}  ${m.id} — ${m.description}`);
    const outcome = await migrate({ db, dryRun: !apply });
    if (outcome?.skipped === 'none_pending') console.log('\nNothing to run: every migration is applied.');
    for (const { id, result } of outcome?.ran || []) {
      console.log(`\n${id}: scanned ${result.scanned}, ${apply ? 'updated' : 'would update'} ${result.updated}, skipped ${result.skipped}, errors ${result.errors}`);
      for (const note of result.notes || []) console.log(`  - ${note}`);
    }
    // Dry runs make no state claims; actual migration execution errors still
    // fail, but locks/unknown skip diagnostics are meaningful only on apply.
    const incomplete = apply ? incompleteMigrations(outcome)
      : (outcome?.ran || []).some(({ result }) => result.errors > 0) ? 'dry run finished with errors' : null;
    if (incomplete) console.error(`\nMigrations are not complete: ${incomplete}.`);
    return incomplete ? 1 : 0;
  } catch (err) {
    if (!(err instanceof MigrationStateError)) throw err;
    console.error('Migration state failure:', err.message, { owner: err.owner, lock: err.lock, version: err.version, cause: err.cause?.message });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
