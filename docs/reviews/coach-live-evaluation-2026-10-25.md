# Live coaching evaluation and remediation

**Evidence archive:** Historical raw captures, logs, and run records are retained privately in archive `googleplato-untracked-curation-20261027T055535Z` (`evidence-1730.tar.gz`). Paths beginning `output/` or `.mobile-ux/` below identify archive members.

The local configuration selects **Cloudflare Workers AI** and
**`@cf/deepseek-ai/deepseek-v4.1-flash-1017`**. The tests used the actual configured
provider through the application's adapters, without changing the selection or
credentials. There was no saved local AI setting overriding `server/.env`.
This identifies the tested local configuration, not an independently verified
production deployment.

All 1,636 existing uncommitted files were archived and verified first at
`/home/ubuntu/.codex/recovery/googleplato-coach-live-20261026T021907Z`. Evaluation
used an isolated SQLite snapshot. Original configuration/database inspection was
read-only; real learner progress was not submitted or updated.

## Results and evidence

Artifacts are in `output/coach-live-evaluation-2026-10-25/`.

| Check | Result |
| --- | --- |
| Complete 14-scenario streaming set | 18 provider calls; all 14 ended with valid assessment metadata. Original strict-label scorer: 13 passes and one safe reference-submission label variation. `final-qualification.json` is unchanged. |
| Behavioral review of the same responses | 14/14 pass. The flagged reference kept progress, objective/exemplar evidence, ownership and profile state unchanged. `final-reviewed.json` retains the original strict failure and the explicit invariant-based grading policy. All 14 original request-body hashes were reconstructed and verified; model output was not rewritten. Behavioral checks are separate from the editorial findings below. |
| Editorial review and affected retests | Agent review found four affected replies in the full set: one inaccurate excerpt-availability claim, two unsupported external handoff promises, and one example that supplied the learner's actual answer. Scoped prompt changes and all affected live follow-ups passed: two reference trials / three calls, two capability cases / two calls, and one scaffolding case / two calls. Original replies and findings remain recorded. This is agent review, not human approval. |
| Actual lesson workflow | Five provider calls; real Hono AI/sync routes and synthetic SQLite records. Opening 0 → unconfirmed page 0 → confirmed work 10 → completed feedback 10. Exact save replay makes no model calls. See `workflow-live.json` and `workflow-final.log`. |
| Captured provenance failure | One actual repair call now grades the valid learner work 10 and preserves the original visible reply exactly. The latest run took 26.0 seconds. `captured-repair.json`. |
| Total provider use | **106 calls**, including diagnostic prototypes, failed attempts, reruns and final validation. `provider-invocations.json` consolidates content-free inference records. |

The full set and later reference, capability, scaffolding and provenance checks
are separately identified runs, not a single run under one final prompt hash.
The final prompt wording was checked on the affected cases; the full 14-case
set was not repeated after those narrow changes. Reports retain prompt, repair,
fixture and request hashes, raw synthetic replies, usage, timing and repair
outcomes. Prompt snapshots are retained beside the reports.
The workflow's assembled prompt hash identifies its stored-plus-bundled coach
prompt, before server program/catalog enrichment; it is not a hash of every
per-request system message.

In the full 14-case set, **9/14 replies had valid first-pass metadata**. Five
omissions were recovered: one opening used known state without another model
call; four active turns each used one metadata-only call. Median case latency
was **3.9 seconds**, maximum **16.9 seconds**. An earlier diagnostic repair took
about 59 seconds including its primary reply. Conditional recovery has a real
latency/call tradeoff; formatting reminders alone did not reliably produce tags.

Two earlier streaming calls produced no usable visible reply. They remain
recorded failures and stopped those batches; explicit follow-ups passed.
There is no automatic provider retry during save/replay and no claim that every
provider request succeeded.

## Findings addressed

**Missing metadata:** useful coaching sometimes omitted PROGRESS and KB_UPDATE.
Format reminders and a compliant assistant example were tested and removed when
they did not solve the issue. `server/src/lib/coach-assessment.js` now recovers
known opening/completed state deterministically. An active malformed reply gets
at most one metadata-only call with the same provider/model and learner context.
The streamed wording is preserved exactly. Malformed, out-of-range or extra-field
repairs fail closed; repairs cannot add profile observations. Source/objective
validation still gates every assessment change before signing.

Recovery occurs during generation. Saving/replaying the signed result never
calls a model or reapplies tags. Telemetry identifies the repair operation and
fixed original parse issues without logging learner prose. Cloudflare's
[JSON-mode documentation](https://developers.cloudflare.com/workers-ai/features/json-mode/)
describes a non-streaming feature and does not guarantee every schema can be
satisfied. The implementation keeps streamed coaching and validates conditional
JSON metadata recovery locally.

**Learner text mistaken for a reference answer:** a repair misread the same
learner answer in the source record and current submission as copied reference
material. It withheld completion while the visible coach correctly acknowledged
mastery. Repair instructions now identify confirmed learner text, explain
duplicate representations of one submission, and distinguish a prior assistant
solution from a later assistant summary of the learner's work. Learner text
still needs to demonstrate reasoning; ownership alone is insufficient. The
captured failure passes its direct live rerun without changing the displayed
reply.

**Generated guidance raised the rubric:** the actual workflow exposed an owner
description requiring named products and a common comparison scale, although the
author required only comparison and a justified choice. The coach treated those
generated details as mandatory. Model context now separates authoritative
`assessmentRequirements` from generated `evidenceGuidance`. Coach, owner and
repair policies prohibit invented real-name, numeric, table, shared-scale or
extra-analysis requirements. The same symbolic A/B page then passed the actual
owner/coaching/save workflow. Guidance remains available for teaching.

**Source-invalid updates left state behind:** independent review reproduced an
unknown source being rejected for progress while still changing learnerPosition,
insights and reference confirmation. IDs are now checked before any semantic
mutation, including non-assessment turns. Image visibility checks precede work
updates. Rejection retains prior summaries/ownership/evidence while preserving
the incoming learner submission and exchange count. Regressions failed before
the fix; independent follow-up verified unknown source, objective and confirmation
IDs. See `independent-review.md`.

**Evaluator fidelity:** current submissions now receive real source IDs; opening
counts and retained evidence are coherent; retraction tests start with an actually
met criterion; old proof cannot share the current message's ID. The runner
supports streaming, selected cases, bounded calls including repairs, and
incremental output that survives provider failure. It retains raw responses and
usage rather than only stripped prose.

Equivalent labels are accepted only for documented equivalent behavior. A
submitted unconfirmed reference labeled `work` passes only when progress,
criterion/exemplar evidence, ownership and profile state remain unchanged.
An assessment label cannot replace a learner question. The original strict-label
failures remain in the evidence.

**Short excerpts:** provided but irrelevant content is no longer described as
unavailable. The final two reference trials correctly acknowledge the excerpt,
ignore embedded grading instructions and preserve the existing assessment.

**Unsupported actions:** feedback and pacing replies promised to pass along or
flag the learner's feedback without an available, confirmed handoff capability.
The coach now avoids claiming external action or promising future delivery it
cannot perform. Both affected cases passed their focused live rerun without
those promises.

**Scaffolding supplied the answer:** a missing-objective reply's worked example
chose the learner's actual option and supplied its reason, undermining the next
assessment. Worked examples now use different named options or a different
scenario; scaffolding on the current work uses blank stems. The focused live
rerun prompted the learner to supply their own choice and justification, while
preserving the comparison already demonstrated.

## Validation and preservation

Fresh results: **598 client tests pass; 752 server tests pass with two PostgreSQL
skips**. Client/server lint have zero errors; the client's 20 existing warnings
remain. The client build and diff check pass, with the existing bundle warning.
The final focused rerun after the prompt/provenance changes passed **70 tests**.
Logs use `*-final.txt` and `final-targeted-tests.txt` in the artifact directory.
Regression coverage includes
exact wording, the one-call repair limit, frozen state, invalid/profile-bearing
repair rejection, source grounding, atomic semantic rejection and save replay.

The actual snapshot baseline is `main` at
`f4254b6c4d652329022249d0059046c671582821`; this task makes no Git mutation or
provider configuration change. This task removed no pre-existing files. Two
Playwright screenshots changed concurrently, and the concurrent audit script
`output/playwright/2026-10-26/_run-audit.mjs` was removed outside this task's edits.
The current artifact locations were left as found; the missing script's archived
original was also copied to the evaluation's `preexisting-recovery/` directory.
The final preservation report records 1,622 unchanged files, 11 intentional
overlapping source/documentation changes, two changed concurrent screenshots and
one absent concurrent script. Original versions of all 1,636 prior uncommitted
files remain in the reverified archive. HEAD, branch and staged diff are unchanged.

This is bounded live evidence for text and supplied link excerpts plus a real
isolated server workflow. Live image grading, production Cloud Run/Cloud SQL,
physical devices, companion profile-model quality and statistically stable model
reliability were not evaluated. Successful cases and metadata recovery do not
independently prove educational correctness for every lesson.

## Scoped publication verification

The coaching implementation and live-evaluation fixes were prepared together on
`fix/coach-assessment-contract`, based on `main` at `f4254b6`, in an isolated
checkout. The 52-file scope excludes concurrent branding, settings and learner
interface work. Shared-file changes were separated against the original recovery
snapshot. The client retains signed coaching, authoritative save reconciliation
and inference-free recovery without including the separate uncommitted learner
submission queue.

Fresh checks on this exact candidate passed: **577 client tests**, **752 server
tests with two PostgreSQL skips**, **15 offline cases with zero provider calls**,
client/server lint with zero errors (20 existing client warnings), client build
and diff checks. Coach and repair prompt hashes match the final live-tested
snapshots. The earlier full-workspace and browser counts above describe those
earlier runs, not this isolated publication candidate. No additional live model
requests were made for publication.

The publication recovery snapshot at
`/home/ubuntu/.codex/recovery/googleplato-coach-publish-20261026T035758Z` preserves
1,777 dirty files, the original index and binary patches. The primary checkout's
files, index, branch and HEAD were unchanged during candidate preparation.
