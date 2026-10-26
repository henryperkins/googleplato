# Coach prompt and assessment remediation

Implemented on `fix/coach-assessment-contract`, based on the consolidated review
in `coach-prompt-consolidated-review-2026-10-25.md`. The original review is retained
as historical evidence. This document describes the resulting behavior and
qualification boundaries. No commit, push, deployment or live provider call is
part of this work.

## Finding coverage

| Finding | Resulting behavior | Main implementation and regression evidence |
| --- | --- | --- |
| F-01: inconsistent completion and pacing | Only 10 means complete, and requires every authored objective plus the exemplar with confirmed source evidence. Opening stays zero. Pacing retains all required criteria. | `client/prompts/coach.md`; `server/src/shared/lessonAssessment.js`, `coachContext.js`; `client/tests/coach-contract.test.js` |
| F-02: permissive parsing and divergent opening handling | One terminal integer PROGRESS and validated KB_UPDATE are required; optional PROFILE_UPDATE is validated. Ambiguous, malformed, fractional, out-of-range or duplicate metadata cannot change assessment. Inline quotations remain visible; streaming suppresses real control tags. Opening uses the same parser/transition rules. | `server/src/shared/coachProtocol.js`; `client/js/coachTransport.js`; contract, transport and server coach tests |
| F-03: lost objectives/rubric and invalid retry accepted | Exact exemplar and all authored objective text/order survive initialization. Stable IDs identify criteria; repeated authored text receives distinct occurrence IDs. The initializer receives coachDirective; a second invalid result fails closed. Evidence definitions cannot erase rubric qualifiers to meet length/pacing targets. | `server/src/shared/lessonInitialization.js`, `lessonMarkdown.js`, `lessonAssessment.js`; `client/js/orchestrator.js`; `client/tests/coach-initialization.test.js` |
| F-04: disappearing source evidence and growing summaries | At most 16 source records retain stable IDs, URL/excerpts or image keys and content digests; observations are at most 10 strings of 300 characters. Required evidence survives shortened history. Images are truthfully marked supplied, omitted or changed; omission cannot establish fresh mastery. | Shared assessment/context; `server/src/lib/lesson-coaching.js`; confirmation-after-truncation, image mutation, fifth-image and long-lesson regressions |
| F-05: ambiguous learner response policies | Work/correction can change assessment. Questions, clarification, uncertainty, feedback, pause and distress preserve it. Corrections replace affected objective evidence; completed assessment stays frozen. Prompt specifies language adaptation, manageable next steps and respect for pausing. | Coach prompt; shared transition function; per-response-type and correction tests; offline fixture suite |
| F-06: compulsory and overbroad profile rewriting | Removed the insight fallback. Only explicit, grounded profile observations can trigger an incremental update; completed-thread feedback cannot. Profile agents can return changed:false. Empty trait arrays and null preferences clear stale facts. Completion/course agents receive demonstrated objectives, excluding raw disclosures. | Profile prompts; `profileQueue.js`, `courseProgressQueue.js`, orchestration; initialization/profile/durability tests |
| F-07: contradictory external-tool rules | Learners may create work in external tools and submit text, screenshots or readable links. Unsupported file uploads remain excluded; an accessible alternative is required when needed. | Coach/authoring prompt alignment |
| F-08: undocumented and over-trusted enrichment | Context documents bounded plugin data and source URLs. Program/catalog/profile/attachment/reference contents cannot override assessment or protocol. Both coaching and legacy startup hooks use the canonical authorized lesson; resource URL metadata permits only HTTP(S). | Coach prompt; shared context; canonical lesson resolver/enrichment; hook and provider-attribution tests |
| F-09: missing evaluation and metadata signals | Content-free `coach_assessment` events report protocol validity, fixed issue codes, response class and completion. A repeatable offline/live runner records fixture and bundled-prompt hashes and actual selected provider/model in live mode, with an explicit call budget. | `scripts/evaluate-coach.js`, `scripts/coach-fixtures.js`; evaluator tests and `offline-evaluation.json` |
| Architectural assessment trust boundary | Server builds coaching inputs from authorized saved records and signs the complete generated result. Save verifies receipts, original base and reset generation without inference. Generic writes cannot replace assessments or transcripts. | `server/src/lib/lesson-coaching.js`, `coach-receipt.js`; AI/sync routes; boundary, tampering, replay, custom/private and reset regressions |
| Minor contract/documentation findings | Name falls back to the account name; no name is invented. Link context describes actual retained-source format. Opening is less dense. Companion prompt function names and nine-prompt inventory are corrected; KB editor includes readable links and catalog text reflects learner access. | Prompt updates, canonical server context, architecture documentation |

The context remains refreshed at the start of history; moving it toward the end
was an unmeasured evaluation candidate, so no speculative layout change was made.
The smaller opening/readability suggestions are reflected in the prompt and
remain part of live editorial qualification.

## Compatibility and recovery

The client stages the exact signed result with its original IDs and base snapshot
in the existing generated-turn journal. Save retries do not re-run initialization,
coaching, parsing, profile models or course models. Streaming text is provisional
until the final signed turn arrives. If that final event is lost, the server keeps
the latest result for the learner/lesson and exposes inference-free recovery by
GET. Recovery reads are bounded and consume empty-cache responses.

A server-owned per-lesson attempt marker is written before inference, so clearing
all user data also fences an opening that has not yet committed its first KB or
message. Recovery manifests/fragments and canonical lesson reads request strong
consistency on DynamoDB.

The recovery result is compressed and divided into records of at most 300,000
ASCII bytes, then published through a digest manifest. This accommodates a valid
conversation and KB whose combined representation would exceed DynamoDB's item
limit. Reads verify the manifest digest and receipt. Replacement removes the
previous result's fragments on a best-effort basis; a failed fragment cleanup can
leave an inaccessible server-owned fragment until ordinary user-data deletion.

Unsigned replies retained before the upgrade preserve their exact text and
attachments as `legacy-unverified`, while retaining only the already saved
assessment. Legacy assistant claims never become new mastery evidence. Active
legacy state is reconciled against the authored criteria; previously completed
lessons remain completed. Generic transcript updates permit only the validated
legacy image migration, with text/identity/provenance unchanged.

Changing the authored exemplar, objectives or assessment directive invalidates
active incompatible evidence. If this happens between generation and save, the
reply is retained, completion is withheld and the saved KB requests reassessment.
Client profile/course side effects use the acknowledged result, so invalidated
completion cannot leak into mastery bookkeeping.

Receipts use a domain-separated HMAC key derived from the stable JWT secret,
survive ordinary process restarts and have no short expiration. Production
rejects the development default. Rotating that secret invalidates outstanding
receipts; preserve pending work before rotation. A malformed supplied receipt
cannot downgrade itself to unsigned legacy recovery.

## Regression and independent review evidence

Logs and reports are in `output/coach-remediation-2026-10-25/`.

- The first shared-contract suite reproduced 27 failures before the fixes; its
  28 cases subsequently passed. Separate owner/profile and transport regressions
  likewise reproduced their failures before correction.
- The initial independent final review found three additional defects: stale
  completion enrichment after criteria changes, omitted-image visibility, and
  oversized combined recovery storage. Permanent regressions cover each fix.
  The follow-up review records all three resolved with no remaining confirmed
  blocker within its scope in `final-review.md`.
- The complete client suite passed **586 tests** (`client-suite-verified.txt`),
  including empty-cache response draining and suppression of stale completion
  and profile observations after an authoritative criteria-change acknowledgement.
- The complete server suite passed **745 tests**, with **2 PostgreSQL-dependent
  tests skipped**, using `node --test --test-concurrency=1` (`server-suite-verified.txt`). Earlier concurrent
  runs hit process-start timeout assertions during a host interruption; their
  failure logs are retained. The serial pass includes the unchanged startup
  checks as well as the coaching, persistence, visibility and receipt tests.
- Offline evaluation passes all **15 authored cases**, with **zero provider
  calls**. `offline-evaluation.json` records prompt and fixture hashes.
- Client and server lint have zero errors; the client retains its 20 existing
  warnings. The client build passes with the existing bundle-size warning.

The browser fixture uses the real React build and repository auth, coaching,
sync and content routes against temporary SQLite. The model and URL-reading
boundaries are deterministic fixtures, and external network requests are blocked.
Both browser suites pass: **12 Chromium scenarios and 12 WebKit scenarios**,
24 total. Results are in `browser-chromium-verified-v2.txt` and
`browser-webkit-verified.txt`; their evidence directories include per-case JSON
and screenshots. The suites cover failure/retry, a newer draft alongside an
older submission, navigation/reload, account isolation, text/images/links, lost
acknowledgements, storage limits, settings durability and responsive layout.
The final browser check also preserved the existing null metadata representation
for submissions without attachments.

## Preservation

Before editing, the complete uncommitted inventory was archived and hash-verified
at `/home/ubuntu/.codex/recovery/googleplato-coach-20261026T003413Z`, including
staged/unstaged binary patches and a 1,472-file manifest. No stash or reset was
used. The preservation check reports zero missing files and 1,466 byte-identical
files; the six intentionally overlapping files are orchestration, lesson engine,
profile queue, the two learner browser fixture/test files, and architecture docs.
The archive preserves their original versions. The previous auth, storage,
composer, draft, settings, layout and other uncommitted changes remain intact.

## Qualification boundaries

These results qualify deterministic contract behavior, mocked provider handling,
local persistence and the tested browser recovery flows. They do not establish
live model teaching quality, physical-device behavior, production deployment,
Cloud SQL behavior or an AWS runtime deployment. PostgreSQL integration requires
`POSTGRES_TEST_URL`.

The live evaluator is an **isolated bundled-coach-prompt evaluation**. It records
the actually configured provider/model, but does not claim to exercise server
admin overrides, program references, plugin enrichment or full history assembly.
Those assembly boundaries have route regressions. Live evaluations require an
explicit bounded command, for example:

```sh
node scripts/evaluate-coach.js --live --trials=1 --max-calls=14 --output=output/coach-live.json
```

No live evaluation was run in this task. Review generated synthetic replies for
assessment accuracy, useful scaffolding, language, truthful source use and profile
restraint before claiming provider quality; automated protocol checks alone are
insufficient. The receipt establishes server provenance, not independent proof
that a model's educational judgment is correct.
