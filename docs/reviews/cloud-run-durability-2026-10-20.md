# Cloud Run durability release — 2026-10-20

The deployment at <https://plato-shaped.ai.studio> now uses a clean Cloud SQL
PostgreSQL database. The operator explicitly declared the previous SQLite
database disposable test data. No old SQLite files or Firestore records were
imported.

## Released configuration

| Item | Verified value |
| --- | --- |
| Application source | `6ab639973137cdc82ad3ea66e50debf38ac5a24e` |
| Included learner durability fix | `91d194eb34e59fabbb06509fe6f0262140185be9` |
| Cloud Run service | `idk-4e9b9 / us-east1 / plato-shaped` |
| Serving revision | `plato-shaped-durable-6ab6399-b`, 100% of traffic |
| Image manifest digest | `sha256:c4e97f4fc1e5fc4a38eb092d2cf0f337af918bc2d6bf2a0398bc54b2ec9ef1f4` |
| Resolved Linux image digest | `sha256:0bad13b19432cc3fd8b1d324ac5b41e8b6a3d86a2925eb33968b6a86723f4432` |
| Database | `idk-4e9b9:us-east1:plato-durable`, database `plato` |
| PostgreSQL | 17, `db-f1-micro`, zonal, 10 GiB SSD with automatic growth |
| Networking | Private IP only; `plato-durable` VPC, `plato-run` subnet, private services access |
| Recovery configuration | Daily backups, seven days of point-in-time recovery, deletion protection |
| Runtime identity | Dedicated `plato-runtime` service account; Cloud SQL client and per-secret access |

The SQL password, stable JWT secret and bootstrap admin password are Secret
Manager references. The AI Studio proxy container and both service/revision
scaling settings were compared with the original configuration and are
unchanged. The public health endpoint returned HTTP 200 with the expected source
commit and serving revision headers.

The release image was built from the isolated committed checkout. SHA-256
comparisons verified eleven release files inside the container against that
checkout, including storage, the lesson engine, the recovery journal, the sync
route, the PostgreSQL implementation, production startup and dependency lock.

## Live verification

These checks used the deployed web app, a synthetic learner and a private lesson.
Model responses were supplied by Playwright interception. Authenticated reads
and successful writes reached the real Cloud Run service and Cloud SQL database.
This verifies persistence and retry behavior; it does not qualify model quality
or provider latency.

| Check | Observed result |
| --- | --- |
| Reject the first generated-turn save with HTTP 503 | The reply and `Retry saving` remained visible. The server still had one opening message, version 1, and progress 2. |
| Reload with an unconfirmed reply | The exact reply and retry action returned from the recovery journal. Model request count remained 1. |
| Retry the rejected save | Three messages persisted at version 2; progress became 6. The model request count remained 1: zero additional model requests. |
| Commit another turn, then abort its acknowledgement | The browser retained the unconfirmed reply. The database already held five distinct message IDs at version 3. Total model fixture requests: 2. |
| Replace the application instance | Deployed revision `...-b` with the same image, confirmed a different Cloud Logging instance ID, and deleted verification revision `...-a`. Reading the deleted revision returned HTTP 404. |
| Read from the replacement | Transcript, lesson state, profile/preferences and screenshot matched the pre-replacement snapshot exactly. The same existing authenticated session worked. |
| Retry the lost acknowledgement on the replacement | The reply became confirmed saved. Model request count stayed at 2; transcript and lesson versions stayed at 3; five distinct messages and three completed activities remained. |
| Refresh the existing learner session | The refresh token issued before replacement successfully rotated afterward. |

The canonical JSON snapshot of the lesson, screenshot and bulk learner sync
records had the same SHA-256 before replacement, after replacement and after the
final retry:

```text
32f96fdcd2d052f98b602a912dd8e70f708956978236b4e9a04d3443d3b956ee
```

There were four save POSTs across the two generated turns: a rejected write, its
successful retry, a successful write with a lost response, and its idempotent
retry. Both retries made zero additional model requests. No model provider was
called during these synthetic browser checks.

The synthetic learner, private lesson, invitation, screenshot and all learner
sync records were removed afterward. Verification refresh tokens were revoked.
The final account/content inventory contained one bootstrap admin and zero
lessons. Normal system defaults and verification audit records remain.

## Validation and review state

- **885 tests passed:** 350 client and 535 server, including real PostgreSQL 17
  concurrency, rollback, reset and reconnection tests. No tests were skipped in
  this run.
- The production container passed login, atomic-save and idempotent-replay smoke
  checks against PostgreSQL.
- The client production build passed. Lint had zero errors and 21 warnings in
  unchanged client files; server lint passed without warnings.
- GitHub Actions jobs did not start because the account is locked for billing.
  The [test run annotation](https://github.com/henryperkins/googleplato/actions/runs/39515837489)
  confirms this; hosted CI is not green.
- Source and this record are on `fix/cloud-run-durable-storage` in
  [draft PR #3](https://github.com/henryperkins/googleplato/pull/3). Main was not
  merged or modified.

The work used `/home/ubuntu/googleplato-cloud-run-durable`. A final comparison
confirmed all 750 original files in `/home/ubuntu/googleplato`, its Git index,
HEAD and dirty status matched the pre-work snapshot. Unrelated local work was
not included in the image or commits. Temporary local PostgreSQL/application
containers and their test network were removed after validation.

The browser also reported the AI Studio proxy's relative service-worker URL
returning HTML under `/lessons/`. This did not prevent either persistence check;
offline/PWA behavior was not qualified by this release.

See [Cloud Run storage](../CLOUD_RUN_STORAGE.md) for configuration, transaction
semantics, test commands and PostgreSQL-compatible rollback procedures. Backup
and PITR settings were verified; this work did not perform a database restore
rehearsal or introduce regional high availability.
