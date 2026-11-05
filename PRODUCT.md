# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary audience is **independent learners who communicate on Slack**, confirmed by the product owner during initialization.

Their learning workflow is self-directed: choose a focused lesson, work toward its exemplar with an AI coach, and return to an existing conversation to continue learning. The particular subject areas, learner experience levels, and Slack workspace arrangements remain unspecified.

## Product Purpose

plato helps learners demonstrate a concrete skill or outcome through a continuous conversation with an AI coach. Each lesson defines one **exemplar**, the mastery-level outcome the learner produces or demonstrates, and **2–4 learning objectives** that support it.

The coach creates activities, evaluates submitted work, gives specific feedback, and adapts the next step using the learner's progress and context. Success means demonstrating the exemplar. Roughly **11 exchanges / 20 minutes** is the current lesson-design target; it is not a guaranteed completion time or a deadline that ends the conversation.

## Positioning

plato combines exemplar-driven microlearning with adaptive conversational coaching. The coach uses the lesson, a program knowledge base, a learner profile, and accumulated observations to guide and assess the learner. Course progress can provide context across related lessons.

Slack is part of the primary audience's communication context. The existing integration supports onboarding through Slack direct messages; learning conversations currently take place in the authenticated web app.

## Operating Context

- Learners choose, filter, and resume lessons at `/lessons`, open a lesson conversation at `/lessons/:lessonGroupId`, and manage their profile at `/settings`.
- Learners submit typed responses, uploaded or pasted images, and attached web links. The coach evaluates this work against the exemplar and objectives.
- Conversations, learner profiles, and progress are persisted on the server. The current product requires an internet connection and sign-in, using a password account or Google sign-in. Browser recovery records support interrupted work; they do not make the app an offline learning service.
- The implemented admin role manages users, invitations, and the wait list, plus lessons, courses, classroom identity, the program knowledge base, AI configuration, and plugins at `/plato`. Courses live within Lessons; appearance and knowledge live within Customizer. Who operates this role for the independent-learner audience is an open decision.
- People join through an admin invitation: a one-time email invite, the shareable invite link, a Slack direct-message invite, or an invite sent from the wait list. Email and link invites expire after 7 days. When email delivery is off, admins receive the sign-up link to share themselves. On Cloud Run, startup creates the admin account from `ADMIN_EMAIL` and `ADMIN_PASSWORD` only when the database has no users. Changing those values later does not create another admin account in an existing database. The in-app setup that names the classroom and creates the admin at first sign-in runs only when an empty database is served without them.
- When an admin opens the wait list, the sign-in page links to `/waitlist`. There, uninvited people leave their name, email, optional group, and the classroom's custom profile fields. Outside forms and systems can add entries through the public wait-list API; a server-held `wlk_` key also works while the list is closed. Admins review entries under Users → Wait List and invite, edit, or remove them. An invite carries the person's answers into a prefilled sign-up. An entry whose email already has an account cannot be invited; **Copy to account** adds the group and field answers that account is missing, then removes the entry.
- Admins create lessons and the program knowledge base through the authoring tools. A lesson is drafted in a Lesson Creator conversation, reviewed as a generated preview, and then saved privately or made public. The authoring workspace supports phone widths as well as desktop. Startup seeds prompts and default theme settings; it does not seed a lesson curriculum or a program knowledge base.
- The optional Slack plugin lets admins connect a workspace, find users or channel members, and send onboarding invitations by direct message. It requires installation and configuration of a Slack app with the appropriate permissions.

## Capabilities and Constraints

These are current repository facts and requirements. They describe the implemented product; the owner has not separately reaffirmed every item as a permanent product commitment.

- **Mastery and pacing:** Progress is an integer from 0–10. Completion requires a valid coach assessment at 10 with evidence for every authored objective and the exemplar, grounded in confirmed learner sources and accepted by the server. A score alone never completes a lesson. Exchange count never forces completion. Longer lessons are a diagnostic for improving lesson design and coaching.
- **Assessment boundaries:** The author's exemplar and objective wording define the requirements. Generated guidance cannot add new criteria. Questions, clarification, uncertainty, lesson feedback, pauses, and distress preserve assessment; substantive work and concrete corrections can change it. Linked pages and images remain reference material until confirmed as learner work. Source confirmation permits assessment of the artifact; it is not evidence of mastery by itself.
- **Completed conversations:** The thread continues for lesson feedback. Its completion, progress, and exchange count stay fixed. Starting another lesson uses its own conversation.
- **Lesson access:** A lesson in progress is a draft that learners never see, and authors can pause and resume drafts. After reviewing the preview, the author chooses **Save privately** (the default; shared only with the author) or **Save & make public** (visible to every learner in the classroom). Either choice saves the reviewed lesson and its visibility together. Saved lessons change visibility from the lesson list or the editor through Visibility & Sharing. Sharing with specific people is independent of visibility and survives a switch between public and private. Only public lessons count toward course progress. Success appears only after the server confirms the save. A failed save keeps the preview and the chosen visibility, so the author can retry without another AI call. Admins also organize lessons into courses and define profile fields. Required profile fields are collected before the classroom renders through the existing client-side gate.
- **Admission:** New accounts should require an invitation, whichever sign-in method a person uses (owner-confirmed 2026-11-01). Password sign-up already requires a valid invite, and the wait list is how uninvited people ask to join. **Known gap:** Google sign-in currently creates an account for any verified Google address, even without an invite or wait-list entry; it applies a pending invite or wait-list answers when one exists. New Google accounts receive the learner role unless the address matches `ADMIN_EMAIL` or the legacy hard-coded `henry@lakefrontdigital.io` address, which receive the admin role. This record does not change that behavior, so do not describe Google sign-up as invitation-only until the code does. Wait-list submissions never reveal whether an email is already registered and send no email. An uninvited Google account can receive a password-reset email before any invitation.
- **Learner records:** Lesson conversations, submitted images, knowledge-base updates, and learner profiles support continued coaching. Images are stored separately from conversation messages; attached links retain their URL and title, with extracted page text used for the attachment turn.
- **Recovery and saving:** Submitted text, images, and links are retained separately from a newer draft, scoped to the account and lesson. A generated reply can remain visible while its save is unconfirmed. **Retry saving** reuses that generated turn without calling AI again; resuming a pending turn does not automatically invoke inference. Browser recovery is best effort and must not be described as a confirmed server save. Profile drafts are also account-scoped.
- **Learner profile:** Durable profile observations need explicit, useful learner information or grounded patterns. A question, one mistake, lesson feedback, or an incidental sensitive disclosure must not become a lasting learner trait.
- **Administration:** The dashboard reports engagement and pacing diagnostics. Admin “View as User” is a read-only inspection workflow.
- **Classroom identity:** Admins can configure a classroom name, logo, primary color, and optional independent accent. Branding applies to learner and authentication surfaces; administration retains plato's identity. Light/dark preference is a per-browser choice, following the device until the person makes an explicit selection.
- **AI dependency:** The server supports Amazon Bedrock and Cloudflare Workers AI. Admins select the provider and supported model at `/plato/ai`; the saved server choice applies across agents. Workers AI supports a connected Cloudflare account or server-configured credentials. Usable credentials and model access are required, and connection, model selection, testing, and saving are distinct actions. Provider availability and a successful credential connection do not by themselves prove usable inference. The currently selected production provider is not established by this product record.
- **Model requirements:** Preserve the repository's requirement for an open-source model with image input and reliable assessment/update signals. [docs/MODEL_SELECTION.md](docs/MODEL_SELECTION.md) records that requirement and its historical evaluation; the older evaluation does not qualify every currently selectable provider/model combination.
- **Implementation and licensing:** The app uses React/Vite and a Hono API, with SQLite for local development. This production deployment uses Cloud Run and Cloud SQL PostgreSQL; AWS Lambda/DynamoDB remains a supported deployment option. Firebase Authentication verifies Google sign-in, and every learner uses the same server-owned storage. The repository is licensed AGPL-3.0. Preserve authentication, access controls, persistence, and URL-fetch safeguards when changing the interface.
- **Slack scope:** The shipped plugin supports invitations. Additional learning or communication workflows inside Slack remain undecided.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CLOUD_RUN_STORAGE.md](docs/CLOUD_RUN_STORAGE.md), and [docs/SAVE_OBSERVABILITY.md](docs/SAVE_OBSERVABILITY.md) before changes to lesson completion, persistence, or Cloud Run/Cloud SQL configuration. Current technical requirements continue to apply unless deliberately changed through the repository's development process.

## Brand Commitments

The existing product name is **plato**, styled in lowercase in product copy and assets. Existing attribution identifies **11:11 Philosopher's Group** as its creator. No rebrand was requested during initialization.

The coach's implemented voice is concise, direct, and specific: brief responses, feedback about the learner's actual work, and one clear next step. It scaffolds the learner's thinking and leaves the learner responsible for producing the exemplar. See [client/prompts/coach.md](client/prompts/coach.md).

## Evidence on Hand

- [README.md](README.md) provides the existing product description and development setup; code is the authority where documentation and implementation differ.
- [client/src/App.jsx](client/src/App.jsx) identifies the implemented learner, authentication, and admin routes.
- [client/prompts/](client/prompts/) contains the bundled coaching and authoring instructions.
- [server/src/shared/lessonAssessment.js](server/src/shared/lessonAssessment.js), [server/src/lib/lesson-coaching.js](server/src/lib/lesson-coaching.js), [client/src/lib/lessonEngine.js](client/src/lib/lessonEngine.js), and [client/src/lib/constants.js](client/src/lib/constants.js) establish assessment, completion, persistence, and pacing behavior.
- [client/src/lib/lessonSubmissions.js](client/src/lib/lessonSubmissions.js) and [client/src/lib/generatedTurns.js](client/src/lib/generatedTurns.js) implement account/lesson-scoped recovery.
- [server/src/lib/ai-provider.js](server/src/lib/ai-provider.js), [server/src/lib/ai-settings.js](server/src/lib/ai-settings.js), and [docs/CLOUDFLARE_OAUTH.md](docs/CLOUDFLARE_OAUTH.md) describe provider selection and connection boundaries.
- [server/src/lib/seed.js](server/src/lib/seed.js) establishes which content is seeded and which admins must create.
- [plugins/slack/docs/README.md](plugins/slack/docs/README.md) documents the existing Slack invitation workflow and configuration requirements.
- [docs/WAITLIST_API.md](docs/WAITLIST_API.md) and the Invite system section of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describe invitations, the wait list, and its public API. [server/src/routes/auth.js](server/src/routes/auth.js) implements invite-gated password sign-up and the current open Google onboarding; [server/src/routes/waitlist.js](server/src/routes/waitlist.js) implements the wait list.
- [docs/superpowers/specs/2026-10-31-lesson-publishing-design.md](docs/superpowers/specs/2026-10-31-lesson-publishing-design.md), [server/src/lib/lesson-visibility.js](server/src/lib/lesson-visibility.js), and [client/tests/browser/lesson-publishing.test.js](client/tests/browser/lesson-publishing.test.js) define reviewed publishing and lesson visibility.
- [client/assets/](client/assets/) contains existing logos and application icons.

This record preserves the owner's confirmed audience and was refreshed against repository code on 2026-10-26. Local browser inspection used synthetic records and a temporary SQLite database. On 2026-11-01 the owner approved adding the admission, wait-list, and reviewed-publishing facts and confirmed that access should be invitation-only; that update was checked against code and documentation without browser inspection. A live deployment, live AI providers, connected Slack workspace, and real learner outcomes were not verified by either pass. No testimonials or outcome statistics were supplied for new claims.

## Product Principles

Working principles derived from the confirmed audience and current product behavior:

1. Prioritize the independent learner's ability to choose, continue, and complete a focused lesson.
2. Make the exemplar, current progress, and next useful action understandable throughout the conversation.
3. Let demonstrated mastery determine completion, while using pacing to improve the lesson and coaching.
4. Fit the learner's Slack communication context with clear handoffs into the web learning experience.
5. Preserve accessible interaction and reliable learner records across the full learning workflow.

## Accessibility & Inclusion

The repository requires keyboard support and an accessible name for every interactive element. The existing product targets screen reader and keyboard-only use, including VoiceOver, NVDA, and JAWS.

Preserve controlled new-message announcements, the silent-by-default chat log, keyboard navigation between messages with `Alt+ArrowUp` / `Alt+ArrowDown`, and `Cmd/Ctrl+Enter` to send. Plain Enter inserts a newline. Loading, error, and progress states need accessible equivalents.

These are existing product requirements; accessibility conformance was not audited during initialization. Additional audience-specific access needs remain open.

## Open Decisions

- Who administers and authors the learning program for independent learners, and which subjects or learning goals it serves.
- Whether Slack remains an onboarding and communication context or gains additional learning workflows.
- Which existing technical, licensing, and pacing requirements the owner wants to reaffirm as long-term commitments beyond the current repository policy.
