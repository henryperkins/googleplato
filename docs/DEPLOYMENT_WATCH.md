# Independent deployment monitoring

`plato-deploy-watch` runs every five minutes in Cloud Run, scheduled by Cloud
Scheduler in `idk-4e9b9`, `us-east1`. It compares GitHub's current `main`, recent
Cloud Build records for `plato-shaped`, and the public health response's
`X-Plato-Commit` and `X-Plato-Revision`. It does not depend on GitHub Actions,
push webhooks, the application process, or a developer workspace staying online.
The monitor never merges, submits a build, replays a webhook, or changes traffic.

This covers the case where a merge succeeds but no push delivery is generated:
an older deployment can still pass ordinary uptime checks. GitHub's delivery log
is the primary place to distinguish no delivery attempt from a failed delivery.
See [GitHub's troubleshooting guide](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks).

## Results and deadlines

Each execution emits one structured `deployment_watch` log. Exit codes are
`0` for a healthy or progressing deployment, `2` for a deployment finding, and
`1` for an incomplete check. Inspect `status`; exit 0 alone does not mean the
new commit is already serving.

| Status | Meaning |
| --- | --- |
| `healthy` | Valid public health response serves the current main SHA. |
| `awaiting_build` | No matching build yet; main's commit is less than five minutes old. |
| `building` | Matching pending, queued, or working build is less than 30 minutes old. |
| `rolling_out` | Matching successful build finished less than five minutes ago. |
| `main_changed` | Main advanced during the scan; defer the comparison to the next check. |
| `missing_build` | Main is at least five minutes old, production differs, and no matching build was found. |
| `build_stalled` | Matching pending, queued, or working build is at least 30 minutes old. |
| `build_failed` | Latest matching attempt failed, expired, timed out, or was cancelled while production differs. |
| `deployment_stale` | Matching build succeeded at least five minutes ago but production differs. |
| `incomplete` | A source, credential, timestamp, identity, or bounded query could not be trusted. |

Builds must match the project, region, service substitution, and exact main SHA.
The newest matching attempt wins, so a recovery build supersedes an older
failure. Main is read again after the scan to avoid treating a concurrent merge
as a failed deployment. The startup grace uses the commit's committer timestamp,
which matches the normal merge workflow; moving main to an older commit can
produce an immediate finding. Timestamps more than one minute ahead are invalid.

The reader scans seven days of builds, follows pagination through empty pages,
and fails explicitly at ten pages, 1,000 builds, a repeated page token, a 1 MiB
response, or a 40-second overall deadline. Historical build details outside
that window are not reconstructed. Public GitHub API rate limits, bad credentials,
unhealthy HTTP responses, and missing identity headers produce `incomplete`.
Requests reject redirects, and Google credentials go only to the Cloud Build API.
The public GitHub API uses no stored GitHub token (two requests per execution).

## Alerts and permissions

The existing operator notification channel receives two dedicated alerts:

- A finding or incomplete report, rate limited to one notification per hour.
- No completed checks in a 20-minute window, sustained for five minutes. This
  covers a disabled scheduler, an execution that never starts, or an early crash.
  Metric ingestion and alert evaluation add latency. Completed error reports
  still count as heartbeats and trigger the first alert instead.

`plato-deploy-watch@idk-4e9b9.iam.gserviceaccount.com` has only the project-level
Cloud Build Viewer role. The platform collects its stdout logs. It receives no
application secrets, database connection, deployment permission, or learner data.
`plato-deploy-watch-scheduler@idk-4e9b9.iam.gserviceaccount.com` has Cloud Run
Invoker on this job only. Scheduler invokes the Google Run API using OAuth.
One task runs per execution, with zero task retries and a 120-second deadline.

## Install or update

The monitor uses the application image, but overrides its command to run only
`node scripts/deploy-watch.js`. Pin it to a released commit containing this script
or an immutable digest. It stays on that version until explicitly updated;
ordinary application releases do not change the monitor's code.

Run from a checkout containing the desired monitor version with Node 20+ and
the Google Cloud CLI. Inspect the script's dry-run before applying. Installation
enables Cloud Scheduler if necessary, creates the two dedicated identities and
their scoped permissions, and configures only the monitor job, schedule, metric,
and two alert policies. It does not modify the application service or trigger.
Discovery failures stop setup instead of being treated as missing resources.

```sh
node deploy/cloudrun/deploy-watch.js --dry-run \
  --image=us-east1-docker.pkg.dev/idk-4e9b9/plato/app:RELEASED_COMMIT_SHA \
  --channel=projects/idk-4e9b9/notificationChannels/EXISTING_CHANNEL_ID
```

Replace the placeholders, then use `--apply` in place of `--dry-run`. Reapplying
updates the named resources. It uses the existing enabled channel and does not
create a recipient or contact GitHub Support. The setup operator needs resource
administration and permission to attach the two service accounts; the running
monitor does not inherit those permissions.

For a local read-only check with Application Default Credentials:

```sh
DEPLOY_WATCH_PROJECT=idk-4e9b9 CLOUD_RUN_REGION=us-east1 \
CLOUD_RUN_SERVICE=plato-shaped node scripts/deploy-watch.js
```

`DEPLOY_WATCH_PROJECT` is deliberately independent of ambient SDK project
settings. Defaults target this deployment. `DEPLOY_WATCH_REPOSITORY` and
`DEPLOY_WATCH_HEALTH_URL` can explicitly override the public repository and
HTTPS health URL for a separately configured installation.

After installation, execute the job once, then observe an actual scheduled
execution and the `plato_deploy_watch_completed` metric. Verify both policies
reference the intended channel. A configured channel is not proof of email
delivery, and fixture tests are not proof of a real production alert.

```sh
gcloud run jobs execute plato-deploy-watch \
  --project=idk-4e9b9 --region=us-east1 --async --quiet

gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="plato-deploy-watch" AND jsonPayload.event="deployment_watch"' \
  --project=idk-4e9b9 --freshness=1h --limit=10 --format=json --quiet
```

## Investigate and recover a missed deployment

1. Read the report and verify the current remote main SHA, the public health
   headers, and active Cloud Builds. An incomplete check must be repaired before
   treating its absence of build evidence as a missed webhook.
2. Check the repository webhook's delivery history. If the merge request timed
   out, read PR and ref state before attempting it again; the merge may already
   have succeeded. No delivery record means there is no delivery ID to replay.
   Never substitute an older main delivery, which would target older code.
3. Serialize recovery with other releases. If any deployment for `plato-shaped`
   is pending, queued, or working, inspect it and wait. A later main commit or an
   active recovery build makes a previously prepared recovery command stale.
4. Confirm the current main change has been reviewed. Fetch it and extract its
   own `deploy/cloudrun/cloudbuild.yaml` into a temporary file. Read main and
   active builds again immediately before submission. Submit that exact SHA
   through the complete existing pipeline, including lint, PostgreSQL/unit
   tests, the client build, and browser regressions. Do not deploy an image
   directly or bypass the test step.
5. Record the build ID, wait for success, verify Cloud Run readiness and traffic,
   and compare public source headers with the intended SHA. If main advances
   while recovering, inspect the concurrent releases before proceeding.

The scoped commands below are building blocks for an operator, not an automatic
retry script. `release_sha` must be the freshly verified remote main SHA, and
`recovery_config` the temporary configuration extracted from that exact commit.

```sh
gcloud builds list --project=idk-4e9b9 --region=us-east1 \
  --filter='status=QUEUED OR status=WORKING OR status=PENDING' \
  --format='table(id,substitutions._SERVICE,substitutions._SHA,status,createTime)' --quiet

gcloud builds submit --no-source --project=idk-4e9b9 --region=us-east1 \
  --config="$recovery_config" --substitutions="_SHA=$release_sha" --async --quiet
```

Automatic delivery is accepted only after a real main merge produces a GitHub
push delivery, a matching automatic Cloud Build, and a ready serving revision
with that SHA. Manual recovery alone proves none of those automatic-event steps.
