# plato Automation — CI/CD & agentic workflows

**Cloud Run status:** GitHub-hosted Actions are permanently unavailable here.
Do not retry or troubleshoot their billing. The workflow descriptions below
are historical/portable deployment context. For Cloud Run, Cloud Build is the
CI: the `test` step in `deploy/cloudrun/cloudbuild.yaml` runs lint, the
client/server unit tests (including PostgreSQL), every plugin suite plus manifest
validation (`npm run test:plugins`), builds the client, installs Chromium and its
system dependencies, then runs every browser suite serially
(`npm --prefix client run test:browser`) before any image is
built or deployed. Its `source` step also extracts Beta-RC-232's `server/src`
(the pinned commit in `ROLLBACK_BASELINE`, `server/src/lib/migrations.js`)
into `server/.rc232`, because the test image has no git, and the `test` step
passes it as `PLATO_RC232_SRC` with `PLATO_REQUIRE_RC232=1`, so the upgrade
gate's rollback checks run instead of skipping. `.dockerignore` keeps that
tree out of the image. After merging a pipeline change, run
`deploy/cloudrun/configure.sh` to refresh the `plato-main` trigger's inline
build configuration.

## Verify a candidate without deployment

For each pushed candidate head, submit the test-only configuration and record
its build ID with the reviewed commit. It fetches that exact commit, starts a
disposable PostgreSQL 17, runs the same lint/unit/plugin/build/browser gate as the
deploy pipeline, then runs the separate Playwright end-to-end suite. It has no
image build, image push, or Cloud Run update steps:

```bash
gcloud builds submit --no-source --project=idk-4e9b9 --region=us-east1 \
  --config=deploy/cloudrun/cloudbuild.verify.yaml \
  --substitutions=_SHA="$(git rev-parse HEAD)"
```

Never submit `cloudbuild.yaml` for a PR head: it deploys `plato-shaped`.
After an approved merge, refresh the webhook trigger's inline config with
`deploy/cloudrun/configure.sh` as described above.

Both configurations explicitly allow 2,400 seconds for the test step and
5,400 seconds for the entire build; the verify configuration gives end-to-end
checks 1,800 seconds. Each step also has an explicit timeout. Browser suite
limits include at least twice their first measured runtime (the admin suite
previously took about 95 seconds in Cloud Build, so its limit is now 300
seconds). Record suite durations from Node's test output on the first hosted
run and increase any budget that has less than 2× headroom. Playwright retries
stay disabled: the shared fixture must pass on its first attempt.

`PLATO_TEST_EVIDENCE` selects a run directory. Browser suites place artifacts
under `<run>/<suite>/<browser>/`, so serial runs and individually selected
suites keep separate evidence. Without the variable they use
`output/playwright/<suite>/<browser>/`.

For a local Docker rehearsal, export the committed candidate into a disposable
directory and run the YAML's test command verbatim in `node:24-bookworm-slim`.
This installs dependencies inside the exported tree, preserving the checkout's
modules. The PostgreSQL container and network are disposable too. The host
needs Docker, Git, and Python 3; `PyYAML` is not required. Extract RC-232 exactly
as the source step does, and supply both required rollback variables:

```bash
rehearsal=$(mktemp -d)
network="plato-verify-$$"
pg="plato-verify-pg-$$"
cleanup() {
  docker rm -f "$pg" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$rehearsal"
}
trap cleanup EXIT

git archive HEAD | tar -x -C "$rehearsal"
mkdir -p "$rehearsal/server/.rc232"
git archive 629c77811985085b88dacabe1514b2f221eb0859 server/src \
  | tar -x --strip-components=1 -C "$rehearsal/server/.rc232"
# If the pinned commit is absent, fetch it first using the source step's command.

# Extract the literal test block; do not maintain a second copy of its commands.
python3 - "$rehearsal" <<'PYTHON'
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
yaml = (root / 'deploy/cloudrun/cloudbuild.verify.yaml').read_text()
step = yaml.split('  - id: test\n', 1)[1].split('  - id: ', 1)[0]
script = step.split('      - |\n', 1)[1]
(root / 'verify-test.sh').write_text('\n'.join(line[8:] for line in script.splitlines() if line.startswith('        ')) + '\n')
PYTHON

docker network create "$network"
docker run -d --network="$network" --network-alias=plato-test-pg \
  --name="$pg" -e POSTGRES_PASSWORD=plato-test postgres:17-bookworm
docker run --rm --network="$network" postgres:17-bookworm bash -c \
  'for i in $(seq 1 60); do pg_isready -q -h plato-test-pg -U postgres && exit 0; sleep 1; done; exit 1'
docker run --rm --network="$network" -v "$rehearsal:/workspace" -w /workspace \
  -e POSTGRES_TEST_URL=postgres://postgres:plato-test@plato-test-pg:5432/postgres \
  -e PLATO_RC232_SRC=/workspace/server/.rc232/src \
  -e PLATO_REQUIRE_RC232=1 \
  node:24-bookworm-slim bash /workspace/verify-test.sh
# Optional: rehearse the verify-only e2e step in the same exported tree.
docker run --rm --network="$network" -v "$rehearsal:/workspace" -w /workspace \
  -e CI=true -e PLATO_REQUIRE_RC232=1 node:24-bookworm-slim bash -c \
  'set -eu; cd e2e; npm ci; npx playwright install --with-deps chromium; npx playwright test'
```

The independent [deployment monitor](DEPLOYMENT_WATCH.md) runs every five
minutes through Cloud Scheduler and Cloud Run. It compares remote main, Cloud
Build activity, and public serving identity, alerts on missed deployments or
incomplete checks, and separately detects a silent monitor. It never deploys;
the same guide documents recovery through the full Cloud Build pipeline.
Current save monitoring reads Cloud
Logging using ADC from a local or external scheduler; `log-watch` is read-only
by default and creates an issue only with `--create-issue`. See
[Save observability](SAVE_OBSERVABILITY.md) for configuration and exit codes.


How plato's GitHub Actions ecosystem works: the agentic workflows (pilot,
intake, review, revise), the data-loss alarm, deploy dispatch, branch
protection, and versioning. For the *error-reporting* side of monitoring (tiers,
how to add a detector), see [`OBSERVABILITY.md`](OBSERVABILITY.md) — this doc
does not repeat it.

This fork's application deployment uses Cloud Run and PostgreSQL; see
[`CLOUD_RUN_STORAGE.md`](CLOUD_RUN_STORAGE.md). The AWS agent workflows remain
configurable independently. The AWS hosting topology and domains described
below are upstream reference material, rather than the fork's current hosting
configuration.

## Claude workflow auth (Bedrock OIDC)

`pilot.yml`, `code-review.yml`, `issue-intake.yml`, and `revise.yml` all use
**AWS Bedrock via OIDC**. Each job has `id-token: write`, runs
`aws-actions/configure-aws-credentials@v4` to assume
`${{ secrets.AWS_BEDROCK_ROLE_ARN }}` in `us-east-2`, then passes
`use_bedrock: "true"` to `anthropics/claude-code-action@v1`. Models are pinned
via `--model` in `claude_args` to Bedrock cross-region inference profiles:
`us.anthropic.claude-sonnet-4-5-20250929-v1:0` for review/pilot,
`us.anthropic.claude-haiku-4-5-20251001-v1:0` for intake/revise. Configure
`AWS_BEDROCK_ROLE_ARN` for the AWS account that runs the fork's agent jobs, with
OIDC trust for this repository and the intended refs, and access to the chosen
model profiles. Each workflow sets its own `role-session-name`
(`plato-<workflow>`), so Bedrock invocation logs and CloudTrail show which
workflow spent what. Track those invocations in the role's AWS account, and
grant model access in the regions covered by the configured cross-region
inference profiles. No `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` secrets are used.

> A PR that modifies a `claude-code-action` workflow file fails that workflow's
> own validation — it requires an admin-bypass merge.

## plato-pilot (`pilot.yml`)

Runs weekday mornings (ET). A once-weekday fix-proposer — **not** a monitor (the
monitor is log-watch, below). Per run, it reads `/tmp/pilot-report.md` (KPIs,
error codes, open pilot PRs as a **blocklist of issues with an open PR**, pilot
merge-rate track record, tier-classified `ready-for-pilot` issues with each
issue's author surfaced as `(by @login)` or `_(self-filed)_`), then picks ONE
signal or SKIPs.

**Severity interrupt** (evaluated before the picking order): a data-loss-class
server error — `unhandled_error` / 5xx on a `PUT`/`POST` write to `/v1/sync`
(surfaced by the report's Data-loss watch callout) — outranks the entire issue
queue regardless of count. The pilot fixes it or escalates with a loud
`SKIP: ESCALATING …` line, never defers it silently. This exists because a
400 KB write-size bug lost learner conversations for 8 days while the pilot
worked one-line copy issues (#195).

**Strict picking order** (top-down — first match wins, no jumping ahead because
something later looks higher-impact):

1. community-authored `ready-for-pilot` issue (author ≠ `plato-pilot`),
   tier-ranked then oldest-first;
2. self-filed `ready-for-pilot` issue;
3. high-count server error on a learner-facing surface;
4. KPI signal.

Volume is not a tie-breaker against authored issues — a one-line community issue
beats a 50-instance error — **except** a data-loss-class error, which the
severity interrupt lifts above everything.

When the pick is issue-driven, the agent commits with a
`Co-Authored-By: <issue-author> <login@users.noreply.github.com>` trailer so
GitHub credits the issue author. Tiers: 1 (learner experience: exemplars, coach,
profiles) → 5 (DevOps). Every pilot PR body must include a Triage table
(Signal / Source / Tier / Decision / Why) plus a `User impact: low/medium/high`
line.

The blocklist is built from **every open PR** that references an issue via
`Fixes/Closes/Resolves #N`, not just `plato-pilot`-labeled PRs — so a
maintainer-authored PR claiming a `ready-for-pilot` issue blocks the pilot from
racing it (closing the dup-gap that produced #160). A pre-agent step emits the
blocklist to `/tmp/pilot-blocklist.txt`; a post-agent step closes any PR that
references a blocked issue (hard dup-gate). A final step auto-escalates looping
issues: when ≥2 closed-unmerged pilot PRs reference the same `ready-for-pilot`
issue, the step removes the label, adds `needs-info`, and posts a comment asking
the reporter to clarify.

**Anti-goals (never violate):** no hard lesson cutoffs, no pacing directive
tightening, `extendedLessons` is informational only.

> Pilot revision commits can stack: the pilot's "Address review feedback" can
> stack on top without reverting — always check the cumulative diff against base.

## log-watch (current CLI; historical hosted workflow)

`node scripts/log-watch.js --dry-run` reads structured save events directly from
Cloud Logging using ADC. It returns 0 for a complete window with no failures, 2
for failure signals, and 1 for incomplete/unavailable monitoring. Recovery
signals are counted separately. Issue creation is opt-in with `--create-issue`
and an explicit `GH_REPO`. Use a local or external scheduler; the old two-hour
Actions workflow is not running for this deployment. The admin-password API
source remains explicit legacy mode for Lambda installations only.
See [Save observability](SAVE_OBSERVABILITY.md) for the full configuration.

## Issue intake (`issue-intake.yml` + `issue-intake-sweep.yml`)

`issue-intake.yml` runs on every newly opened issue and classifies it as either
`ready-for-pilot` or `needs-info`. To qualify as `ready-for-pilot`, the issue
must name something concrete: an exact string/copy change, a specific error
message or screenshot, or a named component plus observed-vs-expected behavior.
Vague reports go to `needs-info` with ≤3 clarifying questions — a false-positive
`needs-info` is cheap, a false-positive `ready-for-pilot` fuels pilot loops.
Non-bug issues get no label, no comment. Idempotent via the labels.

**Backstop:** `issue-intake-sweep.yml` runs every 6 hours. If an on-open intake
run *fails* (e.g. a transient `claude-code-action` internal error, which is what
left #193 un-triaged and invisible to the pilot), the issue keeps no intake label
and falls silent. `scripts/intake-sweep.js` finds open, human-authored,
label-less issues older than an hour and re-dispatches `issue-intake.yml` on each
via its `workflow_dispatch` input; self-healing, since a successful re-run adds
the label and drops the issue from the next sweep.

The sweep's re-dispatch runs as the `github-actions[bot]` actor, so
`issue-intake.yml` must keep `github-actions` in `allowed_bots` — otherwise
`claude-code-action` rejects every retry as a "non-human actor" and the backstop
becomes a silent no-op (this is also the only path that triages issues from
reporters without repo write access, whose on-open run `claude-code-action`
blocks by design).

## Auto code review (`code-review.yml`)

Runs on every PR (opened + synchronize) and posts a review as `claude[bot]`.
Reviews are per-commit idempotent: the guard step queries existing reviews and
skips when a `claude[bot]` review already exists for the current head sha. New
commits (different sha) — including `revise.yml`'s fixup pushes — still get
reviewed. The job still completes when skipped so the required `review` status
check is satisfied. The reviewer prompt instructs the agent to submit exactly
ONE `gh pr review` call. Reviewers must call out live-user impact explicitly and
end every review body with a one-line `User impact:` summary — because merges
auto-deploy to prod, the review is the last human-free checkpoint. A
post-action verify step fails the job if the agent exits without posting a
review. Only one automated reviewer should be active at a time; if the hosted
Claude GitHub App is also installed with auto-review enabled, disable it there to
prevent duplicate reviews.

## Tests, lint, and accessibility (`test.yml`, `lint.yml`, `a11y.yml`)

Run on every PR (drafts included) and on pushes to `main` / `playground`, on
Node 24 to match the Lambda runtime.
- **`test.yml`**: `npm test` for client and server. The server job fetches
  Beta-RC-232's pinned commit for the upgrade gate
  (`server/tests/migrations/upgrade-from-rc232.test.js`): the checkout is
  shallow and this fork has no tags. Under `CI` the gate fails, rather than
  skips, when that commit is missing (`pilot.yml` fetches it too).
- **`lint.yml`**: ESLint for both.
- **`a11y.yml`**: the Playwright + axe suite in `e2e/` against a fresh
  `dev-sqlite` with `AI_PROVIDER=mock`. It fails on any serious or critical
  WCAG 2.1 A/AA violation on any page or dialog, or a broken keyboard flow.
  On failure the Playwright report is uploaded as an artifact.

## Deploy dispatch & environments

Deploy workflows live only in the private fork (UIC-OSF/plato-deploy),
not in the public repo. Deploys are automated via `repository_dispatch`: pushing
to `main` triggers `.github/workflows/trigger-deploy.yml`, which fires a
`deploy-prod` dispatch to the private fork; pushing to `playground` fires
`deploy-playground`. The private fork's `deploy.yml` / `deploy-playground.yml`
listen for those events, check this repo out at the dispatched SHA, and run SAM
deploy.

One-time setup: a `DEPLOY_DISPATCH_TOKEN` secret on this repo (fine-grained PAT
with `contents:write` on the deploy fork). Manual deploy: run `Trigger Deploy`
here via `workflow_dispatch` with a `target` input (`prod` / `playground` /
`both`), or run `Deploy to AWS` / `Deploy to Playground` directly from the
private fork's Actions tab with an optional `ref` input.

- **prod** (`plato` stack) — plato.courses, auto-deploys on push to `main`.
  The retired `learn.ai-leaders.org` hostname now 301s to plato.courses via
  Porkbun URL forwarding (path + query preserved), so old links and invite
  emails still land in the right place.
- **playground** (`plato-playground` stack) — playground.ai-leaders.org,
  auto-deploys on push to `playground`.

### Renaming the deploy fork breaks OIDC

In the optional AWS deployment, the deploy job assumes its configured deployment
role via OIDC, and that role's trust policy matches on the token's `sub` claim. **Renaming the
fork silently breaks every deploy** with `Not authorized to perform
sts:AssumeRoleWithWebIdentity` — the `test` job still passes, so only the deploy
step fails. Update the role's `StringLike` condition on
`token.actions.githubusercontent.com:sub` to match.

Two traps when fixing it:

- **The `sub` may carry immutable numeric IDs, not the repo name** — e.g.
  `repo:UIC-OSF@250423191/plato-deploy@1198593358:ref:refs/heads/main`, not
  `repo:UIC-OSF/plato-deploy:...`. A pattern built from the new *name* won't
  match. Read the actual claim from CloudTrail rather than guessing:
  ```bash
  aws cloudtrail lookup-events --region us-east-2 \
    --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
    --max-results 5 --output json \
    | python3 -c "import sys,json;[print(json.loads(e['CloudTrailEvent']).get('errorCode','SUCCESS'), (json.loads(e['CloudTrailEvent']).get('requestParameters') or {}).get('subjectFromWebIdentityToken')) for e in json.load(sys.stdin)['Events']]"
  ```
  `GET /repos/{owner}/{repo}/actions/oidc/customization/sub` also reports the
  prefix in use, but CloudTrail shows what the token actually presented.
- **Re-running the failed job doesn't help.** A re-run replays the *original*
  OIDC token, minted before the fix. Fire a fresh `repository_dispatch` instead.

For the full deploy procedure, SSM parameters, and backup layers, see
[`DEPLOY.md`](DEPLOY.md).

## Branch protection

`main` and `playground` are ruleset-protected (Settings → Rules → Rulesets →
"Protect main and playground"): required PR + 1 approving review + passing
`review` status check from the Code Review workflow; no force pushes; no deletion.

**Bypass mode**: "Pull requests only" — repository admins **cannot push directly**
to protected branches (even for emergencies), but can merge PRs without waiting
for approvals. This enforces the PR workflow while preserving emergency merge
capability.

This ensures every change to production:
- Goes through a PR (no direct pushes)
- Gets code-reviewed by the Bedrock workflow
- Runs the full CI suite (lint, tests, CodeQL)

### Emergency hotfix procedure

For urgent production fixes:

1. Create a branch: `git checkout -b hotfix/brief-description`
2. Make your fix and commit
3. Push and open a PR: `gh pr create --title "Hotfix: ..." --body "..."`
4. **Merge immediately** (bypass mode lets you merge without waiting for review)
5. The code review workflow will run post-merge for audit

The ruleset blocks direct pushes but doesn't block merges — you retain emergency
override via the merge button, just not via `git push origin main`.

## Versioning

Version is tag-based (`Beta-RC-X`). On push to main,
`.github/workflows/version-bump.yml` creates the next `Beta-RC-N` git tag +
GitHub release. There's no `version.json` tracked in git — the deploy workflow
generates it from the latest tag before packaging Lambda. Local dev: no
version.json means the admin sidebar hides the version label; that's intentional.
