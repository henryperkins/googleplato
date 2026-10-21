# Interface clarity review — 21 October 2026

This record belongs to PR #10 (`fix/interface-clarity-audit`), against `main`.
It covers interface wording and redundant presentation, with the learner and
administrator workflows supplied in the task as the acceptance criteria. It is
an engineering record, outside the application source and static assets.

## Basis and source coverage

Read `AGENTS.md`, `CLAUDE.md`, `PRODUCT.md`, `DESIGN.md`, and the applicable
plugin guidance. Confirmed behavior in the implementation rather than treating
older product documentation as an exhaustive account of the current app. For
example, current AI configuration supports both Bedrock and Workers AI.

The source review included:

| Audience / area | Inspected surfaces and meaningful content retained |
| --- | --- |
| Authentication and onboarding | Sign in, invited and ordinary signup, wait list, password reset, first-run setup, required profile fields, validation and recovery. Classroom identity, privacy links, optional fields, and password controls remain. |
| Learner navigation and catalog | Shell/account menu, course and progress filters, lesson cards, outlines, loading/error/empty states. Lesson identity, course context, resume state, intended outcome, and usable filter recovery remain. |
| Learning conversation | Startup milestones, coach/user messages, outline, exemplar, objectives, reference material and citations, composer, image and link attachments, typing/loading states, saving/retry/conflict/upgrade recovery, feedback and completion/next-lesson actions. No lesson, conversation, draft, attachment, or progress logic was changed. |
| Profile and privacy | Account settings, custom fields, profile feedback dialog, privacy/data-handling text. Credentials, access, provider disclosures, retention, and recovery instructions remain meaningful and visible. |
| Admin navigation and progress | Desktop sidebar, mobile drawer/bottom navigation, dashboard metrics and lesson pacing, refresh/loading/error states. Published-lesson scope, denominators, target thresholds, and meaningful warnings remain. |
| Authoring | Lesson list/search/visibility, course management, new and existing lesson editor, preview/current/stale/saving/conflict states, knowledge-base setup/editor/preview. Draft recovery, private-by-default creation, review-before-save, and destructive confirmations remain. |
| Learner management | Search/filters, user edit/profile/progress, teacher comments, email/CSV/Slack/link invitations, groups, custom fields, wait-list settings and entry editing. Roles, admin-only information, invitation expiry/security, and deletion consequences remain. |
| Classroom, AI and plugins | Branding/color/logo settings, knowledge content, active/pending AI configuration, model capabilities/access, Cloudflare connection/setup/revocation states, plugin activation/settings/permissions/data deletion, Slack connection tests. Administrators retain the identifiers and diagnostics needed to configure integrations. |

Two independent source audits covered learner/authentication and administrator/
plugin surfaces. A separate reviewer approved the final changes without
actionable findings. The review findings from the earlier PR pass are also
addressed: plugin permission dictionaries use own-property lookups, and
metadata permissions describe access to this plugin's records for any user,
including creation, changes, and deletion for write access.

## Implemented findings

| Finding | Change |
| --- | --- |
| Internal storage details dominated Privacy text | Removed database/table/record implementation explanations while retaining actual data handling, providers, administrator access, and browser recovery limitations. |
| Raw plugin capability/schema tokens were difficult to interpret | Added tested plain-language permission labels and readable settings-key fallbacks; kept explicit schema titles and visible unknown-token fallbacks. Documented the permission-label contract. |
| Duplicated navigation guidance and inconsistent account/outline labels | Removed repeated drawer guidance; use “Settings,” “Group,” “View outline,” and “Update profile” where they name the task directly. |
| Startup steps repeated their own meaning | Removed the three explanatory sublines; retained milestone labels, status icons, per-plugin progress, and screen-reader state announcements. |
| Draft and sent link chips repeated the hostname when it was also the title | Render the hostname once in that case; retain a distinct site name when it adds information, plus the complete URL/accessibility description and attachment actions. |
| File-read failures exposed raw exception text | Show a concise image recovery instruction. Technical error details stay in the developer console. |
| Reference material had a technical heading and repeated introduction | Use one “Reference material” heading; retain the material, its purpose, source links, and learning content. |
| Admin dashboard labels did not precisely match calculations | Label the strict completion threshold “Completed more than half of lessons”; label extended exchanges inclusively. Remove redundant in-progress description and shorten pacing suggestions. Calculations are unchanged. |
| User filter called ordinary learner accounts “Active” | Label the existing role-based filter “Learners”; preserve the predicate and counts. |
| Classroom and authoring guidance repeated nearby actions | Shorten branding, course, knowledge-base purpose, and empty-preview help. Remove the oversized decorative empty knowledge-base container while keeping Create Knowledge Base prominent. |
| AI setup prose duplicated server configuration and access explanations | Consolidate the Bedrock note and shorten model guidance. Keep active/pending configuration, credentials versus model access, usage-charge notice, inactive settings, and past-test-versus-current-availability distinctions. |
| Slack test claimed a connection before saving it | Say “Connection test passed … Connect to save.” Keep the saved connection separate and place feedback on its own line. |
| Failed plugin-list requests also claimed “No plugins installed” | Suppress the empty-state claim while a load error is present. Keep the error and Retry action; retain the empty state for successful empty results. |
| Plugin page repeated its title and descriptions exposed unnecessary mechanics | Remove the generic introduction, retain the authoring link, shorten WordPress Info's description, and remove “Private” where “Visible only to admins” already states the boundary. |

No domain-wide word substitution was applied. “Exemplar,” learning objectives,
knowledge bases, providers, plugins, permission scope, privacy information, and
useful administrator diagnostics were retained where they help the audience.

## Verification

- `npm test`: 438 client tests passed; 631 server tests passed, with two
  PostgreSQL-backed integration tests skipped because `POSTGRES_TEST_URL` is
  unset. No failures. The skipped cases cover PostgreSQL concurrent persistence
  and the production `start.js` save-event HTTP path.
- `npm run build:client`: passed on the final source.
- `npm run lint`: passed with zero errors and 20 client warnings; server lint
  passed.
- `node scripts/validate-plugins.js`: all three shipped manifests passed.
- `node --test plugins/slack/server/*.test.js plugins/teacher-comments/server/*.test.js plugins/wordpress-info/server/*.test.js`:
  six tests passed.
- `git diff --check`: passed. The Impeccable source detector reported no
  deterministic findings; its source-only scan does not prove visual quality.
- Existing regression tests cover the permission dictionaries, inherited-name
  fallbacks, metadata permission wording, and generic settings labels. Focused
  browser assertions exercise the changed display and recovery states instead
  of adding tests that only mirror literal copy.

Fresh Chromium captures covered 23 route states at both 1440px and 390px,
including authentication, catalog, conversations/completion, settings, dashboard,
users, authoring, classroom/knowledge-base settings, AI, and plugins. Additional
captures cover dialogs and loading, empty, error, pending, saved, and recovery
states, plus the Plugins page at 320px. Contact sheets and selected full-size
captures were inspected. No page errors or horizontal document overflow were
observed in the captures. Admin data tables retain their intentional internal
horizontal scrolling.

Interaction checks used the fresh built client with actual authentication,
admin, sync, content, profile, and plugin routes against an isolated SQLite
database. AI responses, link retrieval, and external connection tests used local
deterministic responses. Checks cover draft text/images/links across reload,
sent attachment persistence, outline citations and Escape/focus return, image
read failure, failed-save retry without another coach request, completion and
feedback, profile-feedback draft/cancel/focus, learner-role filtering, courses,
invitations/custom-field/wait-list dialogs, empty knowledge-base creation,
AI active/pending/test distinctions, Slack test/connect/reload, and admin-only
teacher comments. Loading/empty/error checks cover the catalog, lesson startup,
plugin retry, required-profile onboarding, and first-run setup.
The focused plugin-list browser regression failed against the original guard,
then passed after the fix for failed, successful-empty, and populated responses.

Representative screenshots use synthetic practice data:

- [Learner outline on mobile](interface-clarity-2026-10-21/learner-outline-mobile.png)
- [Admin plugins on mobile](interface-clarity-2026-10-21/admin-plugins-mobile.png)

## Bundle and verification boundaries

Inspected Vite's copy inputs, Tailwind's plugin source path, the built-file
manifest, and the server's static serving root. The 54 built files contain the
application, fonts, and product icons/logos; engineering reports, screenshots,
runtime scripts, and test data are outside `client/dist`. A search for this
run's distinctive fixture/report markers found none in the bundle. The
`MarkdownPreviewPane` chunk is the legitimate authoring UI, not a review report.
No audit UI or publicly served audit artifact was introduced.

Browser checks are local Chromium automation, including narrow viewports, not
physical-device evidence. They do not qualify live Bedrock/Workers AI access,
Cloudflare/Google OAuth, Slack availability, email delivery, production databases,
native mobile keyboard/gesture/browser-chrome behavior, or a screen reader.
Not every existing error/permission branch was simulated in a browser; source
inspection and the repository tests provide the broader coverage. No deployment
or merge was performed.

## Review follow-up before merge

The remaining inline review findings were checked against the implementation.
The static, hook, and slot permission dictionaries already use own-property
lookups, and the metadata labels already describe this plugin's records for any
user and creation/change/deletion scope.

Two additional findings were addressed:

- The fallback settings form accessed members of null or undefined property
  descriptors. Normalize malformed descriptors to the existing plain-text
  fallback so the panel retains its labels, stored values, and Save action.
  Valid password, boolean, number, and enum fields retain their behavior.
  A test renders the actual component through Vite and React SSR: it reproduced
  the null-description exception before the fix and passed afterward, alongside
  the valid-control regression.
- Add a concise Privacy paragraph explaining that classroom plugins can search
  external websites using lesson-derived terms. This matches the WordPress Info
  planner and query executor; it does not claim that full lesson content is sent
  to those websites or make guarantees about external retention or anonymity.

The follow-up full local test run used a disposable PostgreSQL 17 database,
matching CI's database service: **440 client and 642 server tests passed, with
zero failures or skipped tests**. Build, lint (zero errors, 20 client warnings),
plugin validation, and the independent focused source review passed. Desktop
and mobile browser checks cover the Privacy disclosure and the fallback form's
labels, keyboard order, typed controls, retained values, and save payload.
See the [mobile Privacy capture](interface-clarity-2026-10-21/privacy-plugin-disclosure-mobile.png).

Hosted GitHub Actions did not run the test, lint, or review code. Their failure
annotations report: "The job was not started because your account is locked due
to a billing issue." This is distinct from the passing local checks. No hosted
status was replaced or bypassed, and an independent technical review does not
constitute a GitHub approval from a separate eligible account.
