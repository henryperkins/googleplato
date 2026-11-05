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

Local qualification passed: 758 client tests; 906 server tests with three PostgreSQL
skips; lint with zero errors and 19 existing client warnings; client build with the
existing large-chunk advisory. The PostgreSQL integration suite also runs in the
existing Cloud Build release gate. No new database schema or dependency is required.

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

## Release and scoped repair
Pending final review, release verification, and the backed-up repair of the
reported thread. Production state must be reread immediately before repair;
changed learner work must not be overwritten.


## External review verification
Amazon Q reported that the repair audit actor would be undefined because the
middleware did not set `userId`. Inspection of `authenticate.js` shows it sets
both `userId` and `user`. A real SQLite route regression additionally verifies
that the repair audit row records the authenticated operator and omits transcript
text. The claimed defect did not reproduce; no production change was needed.
Independent final code review remains pending.
