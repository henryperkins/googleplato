# Cloud Run durable storage

The Cloud Run deployment uses PostgreSQL in Cloud SQL. SQLite remains a local
development option; the production HTTP entry point rejects it. Every app
instance reads and writes the same database, including user accounts, refresh
tokens, learner transcripts, lesson state, screenshots, admin content and audit
records. No application database or credentials belong in the container image.

## Runtime configuration

Build the repository's `Dockerfile` and run `node server/start.js`. The image uses
Node 24 and installs the dependency versions recorded in `package-lock.json`.
Keep the AI Studio ingress sidecar when updating the existing Cloud Run service.
Change only the application container image and the documented runtime settings.

Pushing to `main` automatically deploys to `plato-shaped` (`idk-4e9b9`, `us-east1`)
through the GitHub push webhook and the `plato-main` Cloud Build webhook trigger
(`deploy/cloudrun/cloudbuild.yaml`). After editing `deploy/cloudrun/cloudbuild.yaml`,
run `deploy/cloudrun/configure.sh` to refresh the trigger's inline build config.

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `DB_BACKEND=postgres` | Select the shared database; no SQLite fallback. |
| `INSTANCE_CONNECTION_NAME` | Cloud SQL project, region and instance. |
| `PGDATABASE`, `PGUSER` | Dedicated application database and SQL user. |
| `PGPASSWORD` | Secret Manager reference to the SQL password. |
| `JWT_SECRET` | Stable Secret Manager reference, at least 32 characters. |
| `APP_URL` | Public HTTPS app origin. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Bootstrap the operator account in an empty database; password is a secret reference. |
| `PORT` | Application sidecar port, currently 3000. |
| `RELEASE_COMMIT` | Source commit exposed with the serving revision in response headers. |
| `SKIP_EMAIL` | When `true`, email delivery is off: invite/reset attempts log only `email_suppressed` (kind, no address or link), invites return shareable links to the admin with `emailDelivery: 'off'`, and password resets create no token. |

For non-Cloud-SQL PostgreSQL deployments and local integration checks, `PGHOST`
can replace `INSTANCE_CONNECTION_NAME`. Use the PostgreSQL client's TLS settings
as appropriate for that environment. Cloud SQL uses Google's Node connector with
private IP, service identity authentication and encrypted connections. Cloud Run
needs Direct VPC egress into the network peered with Cloud SQL, and the runtime
service account needs `roles/cloudsql.client` plus access to the specific secrets.
No service-account keys or public SQL ingress are required.

The connection pool is limited to five connections per app instance. Account for
the number of Cloud Run instances and overlapping revisions before increasing
scaling. Allow up to 240 seconds for the app startup probe because private network
connectivity can lag a cold start. Database connection errors receive bounded
retries; schema or permission errors fail startup. The process becomes ready only
after database initialization, operator bootstrap and content seeding succeed.
Concurrent content seeders retry version conflicts up to three total attempts,
rereading each record before writing. Other errors still fail startup. The
bootstrap password is removed from the environment before application config
or plugins load, including starts where an operator account already exists.

On `SIGTERM`, the server drains active requests before closing its database
connections. Cleanup errors produce a structured error code without connection
details and exit unsuccessfully. An eight-second deadline bounds open streams
and stalled cleanup, within Cloud Run's
[ten-second termination window](https://docs.cloud.google.com/run/docs/container-contract#shutdown).

## Transaction and retry guarantees

The PostgreSQL adapter implements the existing database contract. A generated
lesson turn commits the transcript and lesson state in one transaction. All sync
mutations acquire a transaction-scoped advisory lock per learner, covering absent
records as well as existing rows. This coordinates generic writes, competing
turns and reset operations across separate processes. The transaction checks
generation, versions and original content before applying the saved result.

The existing `/v1/sync/lesson-turn/:lessonId` API reconciles a lost acknowledgement
by stable message IDs and acknowledges an already committed turn without writing
it again. The existing client recovery journal retains generated replies and
`Retry saving` calls only persistence APIs. It does not repeat inference or
reapply lesson progress tags. These are the durability changes in `91d194e`.

Schema initialization is serialized across instances. Tables store JSONB user,
invite, token and audit documents plus individually versioned sync records.
User email and username uniqueness are enforced case-insensitively. Invite usage
limits and activity counters are atomic database updates. Expired refresh/reset
tokens cannot authenticate and expired token/invite rows are removed at startup.

## Validation

Run `npm ci`, `npm test`, `npm run lint` and `npm run build:client`.
The database integration suite requires a real disposable PostgreSQL server:

```sh
POSTGRES_TEST_URL=postgres://postgres@127.0.0.1:55432/postgres npm run test:server
```

It creates and removes a uniquely named test schema. It checks CRUD contracts,
concurrent optimistic writes, a losing competing turn, rollback after the second
write fails, reset invalidation, same-version content edits, and replacing all
application connections. Without `POSTGRES_TEST_URL`, that suite is explicitly
skipped; mock-based tests alone do not qualify a new PostgreSQL deployment.
Use Node 24 and install from the repository's root dependency lockfile. Run the
PostgreSQL suite against an isolated local PostgreSQL 17 instance.
Additional regression checks cover simultaneous content seeding, bootstrap
credential removal, reset-token rejection by refresh lookup on every backend
(SQLite, DynamoDB and Postgres), expired-token rejection, single-winner
concurrent token consumption, revocation of all sessions on password reset,
and bounded server shutdown. GitHub-hosted Actions are permanently unavailable for this repository.
Use local validation and independent review; do not wait for, rerun, or
investigate hosted jobs as a release prerequisite.

For release verification, use a synthetic lesson and browser-intercepted model
response while retaining real authenticated server writes. Force a save failure,
confirm the reply remains visible after reload, then click `Retry saving` and
assert zero additional requests to any model endpoint. Also drop a response after
a real server commit and confirm retry does not duplicate messages or increment
versions. Replace the Cloud Run revision with the same image, confirm a different
serving revision and instance, and reread the exact transcript, lesson state and
screenshot. Remove only the explicitly created verification records afterward.

## Operations and rollback

Use a clean database for this deployment; the operator declared the previous
SQLite database disposable test data. Do not import old container database files
or backfill from Firestore. Firebase Auth remains the Google sign-in boundary;
learner data stays exclusively in the server database. The
[Firestore retirement runbook](FIRESTORE_RETIREMENT.md) records the named-database
scope and application/rules publication steps.

Cloud SQL is independent of Cloud Run container lifetimes. Enable daily backups,
seven days of point-in-time recovery and deletion protection. A small zonal shared
CPU instance is suitable for this test/pilot deployment, but does not provide
regional failover or a shared-core availability SLA. Compute, disk and backup
storage incur ongoing Cloud SQL charges even when Cloud Run scales to zero.

Rollback must retain the PostgreSQL adapter, database and stable JWT secret.
Deploy a previously qualified PostgreSQL-compatible image if needed. Routing
traffic to the old SQLite-only revision would return users to disposable local
state and is not a valid storage rollback. Never delete the Cloud SQL instance,
network, secrets or database to roll back an application release.

References: [Cloud Run to Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run),
[Direct VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc),
[Cloud SQL pricing](https://cloud.google.com/sql/pricing).
