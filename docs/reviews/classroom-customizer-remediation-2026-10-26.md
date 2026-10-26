# Classroom Customizer remediation — 2026-10-26

Implemented in the `main` working tree at `f4254b6`, against
`classroom-customizer-and-experience-review-2026-10-26.md`. The scope is the
review's five recommended work items. Each finding was re-checked against the
current code before changing it; three of its claims did not reproduce, as
noted below. The working tree also holds unrelated uncommitted changes, which
were left as they were. No deployment, real email, or paid AI inference was
used.

| Review finding | Status on `main` | Implemented behavior | Main implementation |
| --- | --- | --- | --- |
| 1. Stale branding after Save and SPA return | Did not reproduce. `BrandingProvider` wraps only the classroom routes, so it remounts on return and reads the shared cache, which `invalidatePublicBranding(saved)` already updates and broadcasts. The review describes a `sessionStorage` provider that is not in this code. | Regression coverage only: saved branding reaches mounted subscribers without another request, and a browser test saves from `/lessons` → Admin Dashboard → Customizer, goes Back twice, and checks the classroom name, title, header color, and both favicons. | `client/tests/publicBranding.test.js`, `client/tests/browser/customizer.test.js` |
| 2. Fill contrast | Confirmed in light mode: pale and yellow brands put buttons, learner bubbles, and progress fills at 1.0–1.9:1. In dark mode, buttons already held 3:1 on cards; the gaps were primary buttons in dialogs (about 2.7:1 on the popover) and the lessons page's progress bar (about 2.4:1 on the muted track). | Light-mode fills deepen (OKLCH lightness only, hue kept) until they hold 3:1 against the workspace, the darkest light surface; a pale gray brand's fills turn near-black. The header keeps the brand as chosen. Dark-mode fills hold 3:1 against the tinted popover instead of an untinted card. Fill colors are emitted as hex: a rounded `oklch()` could land just under 3:1. Both progress bars fill with the primary-text shade, which holds 3:1 on the muted track. Customizer color notes explain the light-mode change. | `client/src/lib/branding.js`, `client/src/pages/LessonsList.jsx`, `DESIGN.md` |
| 3. Knowledge Base editor | Confirmed: Save re-ran extraction over the reviewed preview, an unchanged knowledge base showed the unsaved banner, nothing guarded leaving, and a missing readiness blocked Save. (LessonEditor has no in-app blocker; its readiness fallback of 8 lives in `AdminLessons.jsx`.) | A current preview is saved verbatim, without extraction; only a missing or stale preview is extracted. The editor saves the knowledge base itself, then lets the page move on, so setup and the Customizer share one save path. An unchanged knowledge base shows no banner. Leaving with unsaved turns, a different preview, or a reply, refresh, or save in progress asks for confirmation, in the app and on reload; while saving, leaving is disabled. Auto-saved turns after the last save carry `unpublished: true`, so a reopened draft shows as unsaved (only `role` and `content` reach the model), and opening the editor reloads the knowledge base so an earlier visit's draft turns are not overwritten. A missing readiness falls back to 8 when content exists. Knowledge bases opened in the old editor stored a readiness of 0, so their Save waits for the next reply. | `client/src/lib/knowledgeBaseDraft.js`, `client/src/pages/admin/KnowledgeBaseEditor.jsx`, `client/src/pages/admin/AdminCustomizer.jsx`, `client/src/pages/admin/AdminKBSetup.jsx` |
| 4. Markdown parity | Confirmed. | `renderMd()` renders fenced code (`<pre><code>`, protected from the other rules; the language class accepts identifiers only; an unclosed fence runs to the end, so streaming replies show code as code), inline code, and blockquotes. Code blocks scroll in a focusable, named region, like tables. `parseLessonPrompt()` keeps every intro paragraph and accepts `## Description` (when both exist, both are kept in order). Lesson cards strip inline Markdown; outline dialogs render it, and exemplars use the full renderer. Code and quotes take a tint of the text color, so code blocks show on the light workspace, which `--muted` matched. | `client/src/lib/helpers.js`, `server/src/shared/lessonMarkdown.js`, `client/src/pages/LessonsList.jsx`, `client/src/pages/LessonChat.jsx`, `client/src/index.css` |
| 5. Match primary and empty themes | Confirmed. | Unchecking **Match primary** starts the accent from the primary on screen. `PUT /v1/admin/theme` rejects a `theme` without `primary` (`{}`, accent only, `primary: null`) with 400. The `#470d99` loading fallback and the `#8b1a1a` reset default differ on purpose (covered by an existing test); an empty theme can no longer reach the fallback. | `client/src/pages/admin/AdminStyles.jsx`, `server/src/routes/admin.js` |
| 6. Favicon | Partly confirmed: only the 32 px icon followed the classroom. The `/plato/*` bleed and the unmount leak did not reproduce: `BrandingProvider` is not mounted on admin routes, and both favicon effects already drop results that arrive after cleanup. | `setFavicon()` updates and restores every `link[rel='icon']`. The browser test checks that both sizes follow the classroom and return to plato's own 32 px and 16 px icons in the admin console. | `client/src/lib/branding.js` |
| 8. Public pages (part) | Confirmed. | A shared `PublicFooter` (link, plato credit, theme toggle) on all seven public pages. `/setup` uses the semantic header tokens instead of an inline `#470d99`. | `client/src/components/PublicFooter.jsx`, public pages |

Not in this change: Finding 7 (logo backdrop or contrast guidance), the
`ProfileCompletionGate` part of Finding 8 (sign-out and a fresh profile check),
and the System/Light/Dark theme control from the review's design
opportunities. None were among the five recommended work items.

The implementation pass recorded the following validation (retained as prior
evidence):

| Check | Result |
| --- | --- |
| `npm test` — server | 766 tests: 764 passed, 0 failed, 2 skipped |
| `npm --prefix server run lint` | 0 errors, 0 warnings |
| `npm test` — client | 650 passed, 0 failed |
| `npm --prefix client run lint` | 0 errors; the 20 existing warnings |
| `npm run build:client` | Succeeded |
| Customizer browser suite, Chromium and WebKit | 11 passed in each, including the new Back-navigation test |
| Admin responsive and learner recovery browser suites, Chromium | 15 and 12 passed |

## Focused validation follow-up — 2026-10-26

The five recommended work items were rechecked against the current working
tree at `f4254b6`. This pass added three browser regressions and updated this
report; it did not change application code or rerun the complete unit or
browser suites listed above.

| Check | Fresh result |
| --- | --- |
| Focused client tests: `branding`, `publicBranding`, `helpers`, `knowledgeBaseDraft`, `lesson-outline-markdown`, and `theme` | 115 passed, 0 failed, 0 skipped |
| Focused server tests: `lesson-markdown`, admin routes, and branding routes | 125 passed, 0 failed, 0 skipped |
| Chromium Customizer regressions | 9 passed in two targeted batches: 6 existing flows and 3 added checks |
| WebKit Customizer regressions | 9 passed in the same two targeted batches |
| `npm run lint` | Exit 0: client has 20 warnings and no errors; server has no warnings or errors |
| ESLint on the changed browser test | Exit 0, no warnings or errors |
| `npm run build:client` | Passed; the existing warning about a minified entry chunk over 500 kB remains |
| `git diff --check` | Passed |
| Preservation check against the validation-start SHA-256 manifest | The browser test is the only tracked file changed during validation. The report was already untracked. Existing application changes were preserved. |

The existing browser checks cover staged resets and save/discard behavior,
sidebar and browser-Back protection, a native reload warning, accent matching,
SPA return with the updated classroom name/title/header and both favicon
sizes, failed style saves, Knowledge editor routing, and following device
theme changes until an explicit choice.

The three added checks exercise the current application through the temporary
SQLite API:

- **Reviewed Knowledge Base save:** existing content with no readiness starts
  at 8 and has a saved-state note. After one conversation reply and one preview
  extraction, Save persists the exact reviewed Markdown, including Unicode,
  with no second extraction. The preview and saved viewer render code and a
  blockquote. Switching tabs asks before discarding the preview, the
  `beforeunload` handler cancels a synthetic unload event, and a successful save
  clears the in-app navigation guard.
- **Reopened draft:** unpublished conversation turns survive leaving and
  reopening the editor, keep the preview stale, and continue to trigger the
  unsaved-change dialog. The previously saved knowledge content stays intact.
- **Rendered color tokens:** for `#f8fafc`, `#bae6fd`, `#eab308`, and `#1d4ed8`
  in both light and dark modes, browser-resolved colors meet 3:1 for primary
  fills against cards and popovers, and for progress fills against muted
  tracks; primary foreground text meets 4.5:1. The check resolves the current
  classroom CSS tokens in the browser and samples their sRGB colors, rather
  than comparing only helper outputs.

The Knowledge tests intercept AI replies with deterministic fixtures while
using the real local API for content and conversation persistence. They do not
qualify live model output. Markdown unit tests also cover safe links and code
escaping, inline rendering in learner outlines, plain-text card summaries, and
multi-paragraph and `## Description` parsing. Theme tests check the shared
footer on all seven public pages.

Fresh logs are in
[`output/playwright/customizer-validation-2026-10-26/validation/`](../../output/playwright/customizer-validation-2026-10-26/validation/).
The new browser screenshots include the
[reviewed preview](../../output/playwright/customizer-validation-2026-10-26/chromium/knowledge-reviewed-preview.png),
[unsaved-change dialog](../../output/playwright/customizer-validation-2026-10-26/webkit/knowledge-unsaved-dialog.png),
and [saved viewer](../../output/playwright/customizer-validation-2026-10-26/chromium/knowledge-saved.png).

This is local source, build, and browser evidence. Physical devices, screen
readers, hosted CI, Cloud SQL/PostgreSQL, production behavior, and live AI remain
outside this verification. No commit, push, or deployment was performed.

## Three review findings — fixes and final verification

The user authorized fixes for the three follow-up findings. These edits were
made on the existing working tree at `f4254b6`, preserving the other pending
work with a verified recovery snapshot and SHA-256 manifest.

| Finding | Implemented correction | Regression evidence |
| --- | --- | --- |
| An older conversation autosave restores unpublished flags after publication | `KnowledgeBaseEditor` tracks already-started draft PUTs in a shared browser barrier and waits for them before the publication PUT. The barrier survives editor remounts and waits through failures; an explicit full save can proceed after a rejected draft. | The new browser test first failed because publication started while the draft was held. It now holds publication and the leave guard until the draft settles, then verifies the exact reviewed content, three published messages, and a clean reopened editor. Unit tests cover reversed completion order, a request added while waiting, and rejection while another draft remains pending. |
| A fenced Description heading becomes lesson metadata | `parseLessonPrompt` tracks backtick/tilde fence markers and opening length. Headings and objective-looking bullets inside the fence stay in the current section. Indented containers and CRLF fence boundaries are recognized; original section-body line endings are preserved. | Seven new parser tests cover the original collision, marker/length rules, unclosed fences, container indentation, and CRLF. Each failing counterexample was observed before its fix. Parser and outline tests pass together. |
| A delayed post-save GET pulls the admin back after navigation | The save callback immediately shows acknowledged content and navigates once. `useResource.refresh` updates metadata in the background, retains acknowledged content on failure, and uses effect cleanup to ignore superseded results. Old timestamps/attribution are hidden until refreshed. GET completion never navigates. | New held-GET and failed-GET browser cases first failed because the editor waited for refresh before navigating. They now show the saved viewer while GET is pending, allow switching to Styles, remain there when GET settles, and retain saved content after a refresh failure. |

An independent agent review identified the container-indentation and CRLF
cases during implementation. Both received failing regressions and fixes; the
reviewer independently verified their closure. No unresolved finding remains
from that bounded review. This is agent review, not a human merge approval.

Final verification uses the source after those parser corrections:

| Check | Result |
| --- | --- |
| Full client unit suite | 653 passed, 0 failed, 0 skipped |
| Full server unit suite | 773 tests: 771 passed, 0 failed, 2 skipped |
| Full Customizer browser suite, Chromium | 17 passed, 0 failed |
| Full Customizer browser suite, WebKit | 17 passed, 0 failed |
| `npm run lint` | Passed: 0 errors; the existing 20 client warnings; server clean |
| `npm run build:client` | Passed; the existing entry-chunk size warning remains |
| `git diff --check` and preservation manifest | Passed; changes are confined to the four implementation files, three test files, architecture documentation, this report, and the new implementation plan |

The two skipped server checks are PostgreSQL persistence/concurrent writers and
the production `start.js` save-observability HTTP check. They require
`POSTGRES_TEST_URL`, which was not configured. They are not passing results.
Browser tests use the freshly built client with a temporary SQLite API and
deterministic AI fixtures. The barrier orders draft requests known to the
current browser application; it does not add coordination between independent
tabs or administrators. No Cloud SQL, live AI, physical-device, screen-reader,
hosted CI, or production qualification is claimed.

Final logs, failing-before/fixed-after evidence, and source hashes are in
[`output/playwright/customizer-regression-fixes-2026-10-26/validation/`](../../output/playwright/customizer-regression-fixes-2026-10-26/validation/).
Fresh screenshots are under
[`output/playwright/customizer-regression-fixes-2026-10-26/final/`](../../output/playwright/customizer-regression-fixes-2026-10-26/final/).
`PLATO_TEST_ARTIFACT_DIR` lets this run preserve the earlier screenshot evidence.
No commit, push, merge, or deployment was performed.


## Scoped publication verification

The publication candidate is isolated on `fix/customizer-experience-regressions`,
based on `f4254b6`. Its 35-file scope includes the reviewed Customizer, branding,
and Markdown remediation plus the three follow-up fixes. The mixed lesson pages
and architecture document include only the relevant hunks. Unrelated coaching,
learner-recovery, Settings, and prompt changes remain in the original checkout.

The earlier test counts describe the combined dirty working tree. The isolated
publication candidate was separately verified:

| Check | Isolated candidate result |
| --- | --- |
| Full client unit suite | 582 passed, 0 failed |
| Full server unit suite | 748 passed, 0 failed, 2 PostgreSQL-dependent skips |
| Full Customizer browser suite | 17 Chromium and 17 WebKit tests passed |
| Lint | Passed; 20 existing client warnings, no errors; server clean |
| Client production build | Passed; existing chunk-size warning remains |
| Scoped diff | Exactly 35 reviewed paths; whitespace check passed |

Dependencies were reused from the existing installation; application source,
configuration, server fixtures, and the production client build came from the
isolated checkout. Browser evidence used temporary SQLite and deterministic AI
fixtures. Publication logs are retained locally under
`output/playwright/customizer-publication-2026-10-26/validation/`.

This is a feature-branch publication. It does not merge into `main` or change
deployment controls. The original checkout and index are preserved.

## PR qualification — PostgreSQL and deployment controls

The application source at `e2d7e8de9935fe278a52a1a7eff958d1e128977d` was
checked again in the clean feature worktree on 2026-10-26, after a fresh
`npm ci --no-audit --no-fund`. `npm test` ran against a disposable local
PostgreSQL 17 database with `POSTGRES_TEST_URL` configured:

| Check | Fresh result |
| --- | --- |
| Full client unit suite | 582 passed, 0 failed, 0 skipped |
| Full server unit suite, including PostgreSQL | 761 passed, 0 failed, 0 skipped |
| PostgreSQL persistence and concurrent writers | Passed, including its 11 nested checks |
| Production `start.js` save-observability HTTP check | Passed |

The two previously skipped checks were **PostgreSQL persistence and concurrent
writers** and **the production `start.js` save-observability HTTP check**.
Both now pass. Enabling the persistence suite discovers 11 nested checks,
which explains the change from 748 passes and two skips to 761 passes.
This qualifies the PostgreSQL adapter and production entrypoint against a
disposable database; it does not exercise the live Cloud SQL instance.

The 17 Chromium and 17 WebKit browser passes above remain the isolated
application-source evidence. The following screenshots were copied unchanged
from that publication run into tracked review assets:

- [Styles, desktop light mode](assets/customizer-experience-20261026/styles-desktop-light.png)
- [Styles, desktop dark mode](assets/customizer-experience-20261026/styles-desktop-dark.png)
- [Styles, phone viewport dark mode](assets/customizer-experience-20261026/styles-phone-dark.png)
- [Reviewed Knowledge Base preview](assets/customizer-experience-20261026/knowledge-reviewed-preview.png)
- [Knowledge Base unsaved-change dialog](assets/customizer-experience-20261026/knowledge-unsaved-dialog.png)
- [Saved Knowledge Base viewer](assets/customizer-experience-20261026/knowledge-saved.png)

Live control inspection found GitHub's **Trigger Deploy** workflow
`disabled_manually`, while the independent Cloud Build **plato-main** trigger
is enabled. Its filter accepts `refs/heads/main` pushes, and its inline build
runs lint and the PostgreSQL-enabled unit suite before building and deploying
`plato-shaped` in `idk-4e9b9/us-east1`. The GitHub push webhook is active with a
successful last delivery. Cloud Build `1579cab7-d6a3-479a-9ad5-bcd614a21adb`
successfully deployed current `main`, `f4254b6`, to ready Cloud Run revision
`plato-shaped-00036-h5z`, serving 100% of traffic at inspection time.
Merging this PR therefore also releases it with the current controls.

An approving GitHub PR review and passing checks remain merge prerequisites.
The earlier agent review does not satisfy that approval. Production behavior
must be verified after the reviewed release; the local fixture screenshots
do not claim live acceptance.
