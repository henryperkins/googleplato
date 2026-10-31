# Lesson review and mobile administration refinement

The user approved all four findings from the 2026-10-31 Impeccable critique and selected a single page with both save choices after the preview.

## Selected approach

- Keep conversational authoring and the preview on one page. Preserve the side-by-side desktop layout. Put one set of save choices directly after the preview, with private emphasized, and move Start over beside the conversation. On narrow screens the preview uses the page's scrolling flow.
- Keep the desktop lesson table. Use compact mobile lesson rows with title, visibility, course, date, named actions and optional metrics. Keep search visible and group course/visibility filters in a native disclosure.
- Define readiness as how fully the conversation specifies the lesson. Provide a concise rubric and the actual 3/10 creation threshold, while preserving all numeric thresholds, colors and preview validation. Review of the exemplar and objectives remains explicit.
- Keep all six admin destinations directly available with visible labels. Use two rows on narrow phones and one row when there is room, adapting to enlarged text without clipped labels.

Separate Edit/Review views were considered and declined. A More navigation destination would require choosing which administrative tools to hide; the selected labelled layout preserves existing destinations and routes.

## Constraints

Preserve the current private/public model, exact-preview saving, versioned operations, unknown-save recovery, shares, authentication, existing draft state and all server validation. Reuse existing UI primitives and native disclosures. Add no dependencies, paid model calls, database changes or production actions. Preserve all earlier uncommitted implementation work; a verified recovery snapshot is recorded in `output/playwright/lesson-mobile-refinement/`.

## Verification

Browser regressions must demonstrate adjacent save choices at the end of short and long previews, keyboard-operated mobile filters/actions, visible navigation labels at 320px and enlarged text, preserved readiness threshold, and unchanged publishing/recovery behavior. Verify desktop and narrow light/dark rendering, the full client/server suites, lint, build and existing responsive admin checks. Physical devices and spoken screen readers remain separate evidence gaps.
