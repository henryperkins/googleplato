# Coach conversation continuity qualification

The reported resumed audit showed a Berkshire Hathaway assignment to the learner
while excluding that legacy assistant message from the model request. The coach
then supplied Hacker News and saved an unsupported stylesheet diagnosis. Live
stored-record inspection and the serving source confirmed the missing provenance
marker and the history filter responsible.

## Resulting behavior
- Retain old coach questions as unverified conversation context, never learner evidence.
- Preserve exact source-backed assignment/direction anchors outside the recent-history window and assessment resets.
- Clarify terse observations, acknowledge an earlier coach switch, and require an explicit learner request before changing targets.
- Describe future suggested websites as candidates unless supplied evidence establishes their appearance/failures. Existing authored criteria and ongoing targets are unchanged.
- Provide a scoped admin repair with full-snapshot optimistic concurrency, named-note removal, unchanged transcript/assessment, and stale-recovery protection.

## Verification
The exact legacy resume regression first failed on the missing Berkshire question
and then passed. Additional RED-to-GREEN regressions cover attachment-placeholder
rejection, unavailable repair routes, empty assignment source rejection, and
continuity grading. Route tests cover current/legacy history, unverified mastery,
long histories, rubric changes, actual learner task changes, authorization,
completed-state rejection, concurrent commits and old receipt/recovery replay.

Local qualification at `f3b293f` passed: 758 client tests and 929 server tests, including
disposable PostgreSQL integration, with zero failures or skips; lint with zero
errors and 19 existing client warnings; client build with the existing large-chunk
advisory. No new database schema or dependency is required.

## Synthetic live coaching evaluation
Four cases ran against the production-selected Workers AI model
`@cf/deepseek-ai/deepseek-v4.1-flash-1017`, using the candidate bundled prompt plus
the current stored teaching prompt, synthetic conversation state, and the generic
messages API. Five provider calls were used out of eight allowed: four coach
replies and one metadata-only repair. No real learner conversation was generated
or saved by this evaluation. Program reference/enrichment inputs were not included;
request assembly and persistence are separately covered by route tests.

| Case | Observed behavior | Agent editorial review |
| --- | --- | --- |
| Legacy audit resume | Asked which element looked unstyled and what effect it had; did not change sites or assert stylesheet failure | Pass |
| Already-drifted thread | Acknowledged its own site switch and explicitly restored Berkshire | Pass |
| Opening outside 40-message history | Recalled the Berkshire assignment | Pass |
| Explicit learner target change | Switched to Hacker News, retained the rubric, and emitted the current learner source ID | Pass |

The initial automated grader falsely failed the first case because it required the
site name in every clarification. The actual reply was on topic and introduced no
other site. A failing test demonstrated that grading defect; the corrected rule
rejects substituting Hacker News without demanding repetitive site naming. The
captured responses were regraded without new model calls or request changes.
Both the [original report](coach-conversation-continuity-2026-11-05/live-evaluation.json)
and [reviewed report](coach-conversation-continuity-2026-11-05/live-evaluation-reviewed.json)
are retained, including original failure, raw replies, request/prompt hashes, usage,
metadata repair and agent editorial observations. These four synthetic examples
support the specific behavior; they are not an exhaustive model-quality claim.

## Review-driven qualification

The independent whole-branch review found three important issues. Each reproduced
in a failing regression and passed after correction:

- Later additive directions could evict an earlier selected target. All exact
  learner directions now remain retained, bounded by the existing saved-record
  limit rather than an arbitrary count. Five directions plus 45 later messages
  retain the selected target and all later constraints in provider context.
- A criteria edit between generation and save could discard a signed direction.
  The save-time assessment reset now reconciles that turn's conversation state.
- Duplicate legacy message IDs could select inconsistent source text. Normal
  reconciliation excludes ambiguous anchors; repair rejects ambiguous assignment,
  learner and correction identities without mutation.

The review fix pass also tested a proposed omission warning against the live model.
It was insufficient: the model reverted to the opening target, and withholding
the opening still allowed it to invent a different target. That design was removed.
One attempt returned HTTP 503. An exact-retention test using a reserved `.example`
domain exposed a fixture conflict with the authored requirement for a real public
website; the model recognized that placeholder. Repeating with Hacker News passed:
the coach retained the earlier target, homepage scope, keyboard focus, plain text,
and two-sentence limit after the history rolled over.

The initial eight-call qualification budget was extended once by two calls to
resolve the review finding, for ten total calls including the HTTP 503 attempt.
The final successful case used the final prompt and source-retention design.
The [retained-directions report](coach-conversation-continuity-2026-11-05/live-retained-directions-public-target.json)
contains the complete synthetic fixture, hashes and response. Earlier experiments
are retained alongside it, including failures; they are not represented as passes.

## Release and scoped repair

PR #40 contains the qualified implementation. GitHub Actions could not start its
lint/test jobs: the check annotation says, "The job was not started because your
account is locked due to a billing issue." Local checks pass, but these hosted
checks and the required approving review remain release gates. No merge,
deployment or production continuity mutation has been performed.

The reported thread was reread and backed up privately on 2026-11-05 at 08:02 UTC.
It still contains the same three messages, message version 2 and KB version 2.
The serving release remains `2ceecb8e8213f1328055cb2821c787a395d2b8cf`, revision
`plato-shaped-00054-x78`. A prepared repair script defaults to backup-only,
requires a verified serving commit before applying, validates the exact expected
message identities/content, uses the full snapshot for optimistic concurrency,
and verifies unchanged transcript/assessment plus a fresh persisted read.
It must take a new backup immediately before applying after release. No model call
or learner message is needed for the repair.


## External review verification
Amazon Q reported that the repair audit actor would be undefined because the
middleware did not set `userId`. Inspection of `authenticate.js` shows it sets
both `userId` and `user`. A real SQLite route regression additionally verifies
that the repair audit row records the authenticated operator and omits transcript
text. The claimed defect did not reproduce; no production change was needed.
The independent review's three material findings are addressed by the regressions
above. The reviewer did not claim production deployment/repair verification or
general model reliability; production actions remain pending and the synthetic
live evidence is limited to the cases actually exercised.

## Follow-up to the five findings on `f3b293f`

All five supplied review findings reproduced before the corresponding changes.

| Finding | Correction and regression |
| --- | --- |
| Historical learner selections missing during migration | Version 2 preserves chronological historical learner statements as `legacyLearnerContext`, separately from classified `learnerDirections`. Actual requests retain the earlier selection after both history and source rotation; migration remains stable on later turns and never awards assessment credit. |
| Attached target URL lost | Saved link URLs/titles accompany learner anchors and recent history. A real generated linked direction survives reload, 24 later submissions, source eviction and history rollover. Reconciliation rehydrates the saved URL; page excerpts are excluded. |
| Target substitution falsely passes | Each continuity fixture declares allowed URLs. Unknown URLs, Markdown destinations, bare domains and known replacement names fail even when the expected target also appears. |
| Unsupported diagnoses falsely pass | Explicit forbidden-observation patterns grade the resulting retained insights and learner position. Valid replies containing each supplied diagnosis fail while neutral observations pass. Reports expose the actual retained observation fields. |
| Unexpected task-change markers pass | Every continuity fixture explicitly expects marker omission unless it describes a genuine current task change. An unsolicited marker fails; genuine changes still require the exact source ID. |

Final follow-up validation: **762 client tests and 934 server tests pass**, with
disposable PostgreSQL enabled and zero skips. The focused set passes 59 tests;
all 21 offline fixtures pass. Lint has zero errors and the same 19 existing client
warnings; the client build passes with the existing chunk-size advisory.

Two new synthetic live cases used the configured Workers AI model and candidate
prompt, with two calls out of a four-call limit. Both passed the strengthened
grader and agent editorial review: the legacy case recovered the earlier
learner-selected Hacker News URL, and the linked case resolved "Audit this site
instead" to its saved URL after it left both bounded lists. The
[live report](coach-conversation-continuity-2026-11-05/live-user-review.json)
retains fixtures, replies, hashes and provider identity. No real learner record
was generated or modified.

The four initial captured replies also pass the strengthened grader in a separate
[historical regrade](coach-conversation-continuity-2026-11-05/user-review-historical-regrade.json).
That regrade made no model calls and does not claim that their original requests
used the new migration code. All earlier raw reports and failed experiments
remain intact. URL and diagnostic-pattern checks deliberately fail conservatively
for the declared cases; they do not recognize every possible semantic substitution
or unsupported claim. Additional provider behavior still requires editorial review.

This follow-up changes the PR branch only. Deployment and the backed-up repair
remain pending hosted checks and an approving review.
