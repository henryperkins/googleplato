# Upstream launch integration design

The maintainer approved the six-step integration proposal in this conversation on 2026-11-06. This fork has no actual users. The deliverable is a working integration branch, a verified preview and a draft PR; merge to main and deployment follow later review.

## Scope

Integrate upstream playground at 1105f340a7ebd48185ab287277e779ad8be2fddc into fork base 257680dacebcf37a107e9b0c511dea396e15872e. Preserve upstream ancestry and bring across the launch feature set: roles and permissions, first/last names, Course–Unit–Lesson hierarchy, admin tables, messages/notifications and automations, existing-account invitations, bundled Getting Started course, lesson overview and agent details, composing during a response and learner profile corrections. Preserve existing useful fork behavior and UI improvements while adapting those features.

The separate admin agreement proposal #500, ping #499 and historical proposals are excluded. Workflow session naming and dependency patches already in playground are included once. Fix all six confirmed playground defects as part of integration.

## Architecture

Keep React/Vite, Hono, the root npm workspace lockfile, Cloud Run server/start.js and PostgreSQL production storage. SQLite remains local and DynamoDB/Lambda remains a supported option. Existing Bedrock and Workers AI selection and Firebase Google sign-in remain usable. New backend operations must implement identical conditional semantics on every adapter. New jobs must run to completion on the HTTP host rather than depend on post-response CPU.

Learner coaching remains server-owned: source provenance, server assessment, signed coach receipts, atomic progress/transcript commits, request deduplication, generated-reply retention, account/lesson ownership and persistence-only retry remain binding contracts. UI metadata is produced before signing or derived separately for display. The current single composer, draft/submission journals, accessibility and extracted authoring components remain the integration foundation.

## Required corrections

1. Validate/encode lesson export paths independently of stored identifiers; resolve every output beneath the selected directory. Test malicious existing IDs and API-created IDs.
2. Create absent notify:state and jobs:schedule records conditionally. Preserve acknowledged opt-outs and single claim winners under actual SQLite/PostgreSQL adapter semantics.
3. Leave failed email recipients/jobs retryable, retain successful claims, propagate dispatch failure and provide meaningful admin state.
4. Serialize complete learner-note edits with profile updates or rebase learner-owned fields immediately before saving a model result. Bind every operation to the originating account.
5. Retain failed submitted attachments separately from the newer draft; never silently truncate a combined recovery draft.
6. Bind profile refresh response, cache writes and React publication to the session that started the request.

## Preservation and presentation

Keep the fork's branding validation and atomic assets, accessible derived themes, fixed nested-page startup, URL-fetch safeguards, authentication/refresh revocation, strict sync versioning, public-only KPI counting, content validation, authoring save/recovery flows and read-only impersonation. Use existing UI components and semantic tokens; preserve keyboard names, focus and responsive behavior. Update assessment/onboarding text to describe selectable providers and trusted server assessment.

No actual users means there is no live-user transition to protect. Existing authored content, local evidence, configuration and services are not implied disposable. Work occurs only in the integration worktree. Preview uses a disposable database, synthetic accounts and mocked AI for repeatable checks; do not send external email or Slack messages. Preserve the main checkout and unrelated services.

## Acceptance

- Full integrated client/server tests, lint and build pass, with PostgreSQL tests exercised against PostgreSQL 17.
- New regressions cover the six defects, storage helper concurrency and production app assembly.
- Browser evidence covers admin/learner roles, invites, hierarchy, authoring, learner save/retry, account switching, profile notes, messages and unsubscribe at desktop and narrow widths.
- Plugin tests and manifest validation pass.
- A verified usable preview and draft PR identify the final commit, tests and limitations. No auto-deployment is triggered from this feature branch.

