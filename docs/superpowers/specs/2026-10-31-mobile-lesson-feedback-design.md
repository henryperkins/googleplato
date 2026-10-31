# Mobile lesson feedback and entry position

The owner requested all three findings from the second mobile pass be addressed.
The scope is the lesson-authoring UI: failed refresh feedback, access to refresh
before long stale content, and initial editor positioning.

## Selected approach

- Keep one Refresh preview control in the preview header whenever content exists,
  including stale content. Keep Generate preview for an empty preview and final
  save/update choices after the content.
- Connect refresh errors to the initiating control. Reveal an error only while
  that control remains focused in the visible Preview panel; retain its focus.
  A failed background refresh must preserve the author's focus and scroll.
- Add an opt-out from initial chat pinning and apply it only to lesson authoring.
  The title, saved status and tabs stay visible on entry. Explicit submission
  still resumes following; learner chat retains its existing default.

## Approaches considered

Keeping refresh only after the preview retains the measured scrolling problem.
Duplicating refresh and errors at both ends adds competing controls and live
announcements. A single header refresh uses the existing preview control and
keeps final saves after review. Globally removing initial chat pinning would
change learner behavior, so the editor receives an explicit opt-out instead.

## Constraints

Preserve exact-preview saving, readiness thresholds, versioned operations,
visibility, recovery, shared knowledge-base behavior and learner scrolling.
Add no dependencies, model calls, backend/schema changes or production writes.
The owner subsequently authorized committing and pushing the isolated feature
branch. Merge and deployment remain outside this request.

## Acceptance

Browser regressions must first reproduce each finding, then demonstrate visible
refresh/errors on long previews at 320/390px, unchanged stale-save blocking,
preserved background focus/scroll, top-position editor entry, continued following
after explicit submission, and unchanged returning-tab behavior. Verify both
Chromium and WebKit, the full unit suites, learner/admin browser checks, lint,
build and a final independent code review. Device and spoken-screen-reader
qualification remain separate.
