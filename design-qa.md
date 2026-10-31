# Admin lesson workspace — design QA

Date: 2026-10-31

final result: passed

## Scope and source

Implemented the selected admin concepts in the existing React application: the
paired desktop workspace, mobile Refine / Preview tabs, and separate conversation,
preview and final-save states. This is an integration of visual proposals with the
existing authoring workflow, rather than a pixel-for-pixel replacement of the admin
shell. The learner library and coaching concept in Photo 1 is outside this change.

Source directory:
`/tmp/codex-remote-attachments/01a19391-c64a-7a90-b823-459ae3e45789/42590FA3-E327-4617-BB5F-108E51CEDF29/`

- `4-Photo-4.jpg`: desktop creation with a current, unsaved preview.
- `3-Photo-3.jpg`: public lesson editing with a stale preview.
- `2-Photo-2.jpg`: mobile Refine and Preview views.

Each source sheet is 1280 × 853 pixels. The desktop app occupies approximately
1244 × 804 pixels within the sheet; each mobile screen occupies approximately
338 × 728 pixels. These are generated design boards without an authoritative CSS
viewport or device density. Comparison excludes the boards' outer margins, device
frames and captions; it evaluates the app content and interaction states. No
pixel-difference score or exact density equivalence is claimed.

## Rendered evidence

The real built client ran against disposable local SQLite services. Browser
fixtures supplied the sample lessons and deterministic AI replies. A separate
test saved and read the exact reviewed markdown and public visibility through the
real local API and SQLite.

Captures use a device scale factor of 1: screenshot pixels equal CSS pixels.
Desktop captures are 1280 × 900; mobile captures are 390 × 900. Additional tests
cover 320 × 900 and 200% root text size. Both light and dark themes were rendered
in Chromium and WebKit.

| State | Chromium capture |
| --- | --- |
| Desktop create and review | [create-preview-1280-light.png](docs/reviews/lesson-workspace-2026-10-31/screenshots/create-desktop-light.png) |
| Desktop public lesson needs refresh | [edit-stale-1280-light.png](docs/reviews/lesson-workspace-2026-10-31/screenshots/edit-stale-desktop-light.png) |
| Mobile Refine | [create-refine-390-light.png](docs/reviews/lesson-workspace-2026-10-31/screenshots/refine-mobile-light.png) |
| Mobile Preview and save | [create-preview-390-light.png](docs/reviews/lesson-workspace-2026-10-31/screenshots/review-mobile-light.png) |
| Narrow dark refresh failure | [refresh-failed-320-dark.png](docs/reviews/lesson-workspace-2026-10-31/screenshots/refresh-failed-narrow-dark.png) |
| Enlarged-text review | [preview-enlarged-text.png](docs/reviews/lesson-workspace-2026-10-31/screenshots/review-enlarged-text.png) |

Portable WebKit [dark mobile review](docs/reviews/lesson-workspace-2026-10-31/screenshots/review-mobile-dark.png)
and [public editing](docs/reviews/lesson-workspace-2026-10-31/screenshots/edit-stale-mobile-dark.png) captures accompany this report.
Additional generated captures remain in `output/playwright/lesson-workspace/webkit/`. The original reference and resulting
captures were opened together in the same comparison inputs. Full views were
compared for composition; the mobile screenshots also provide readable focused
views of tabs, preview status, typography, actions and classroom audience copy.
Separate image crops were unnecessary for those details.

## Findings and comparison history

No actionable P0, P1 or P2 issues remain within this scope. The independent
technical review's responsive focus finding was corrected and rechecked in
Chromium and WebKit.

1. **P2, mobile review density — fixed.** The first implementation repeated
   “Lesson preview” below the selected Preview tab and repeated the save directions
   below the audience explanation. The repeated header and copy pushed useful
   review content down. The heading remains available to assistive technology;
   the current-preview row now shares space with a named, 44px refresh control.
   Redundant save directions are visually hidden while retaining button
   descriptions. Final evidence: `chromium/create-preview-390-light.png`.
2. **P2, desktop composition — fixed.** The existing 896px admin content cap left
   unused room beside a compressed paired workspace. The lesson editor now uses
   the available width up to the existing 6xl size, with approximately 1.15:1
   conversation/preview columns. Course and readiness align above them. Final
   evidence: both desktop light captures above. The prior narrower composition
   is retained in [before-desktop-width.png](docs/reviews/lesson-workspace-2026-10-31/screenshots/before-desktop-width.png).
3. **P2, mobile vertical rhythm — fixed.** The initial expanded readiness block
   consumed conversation space, and an unused grid row left an extra gap above
   the preview content. Readiness now has a compact, keyboard-operated disclosure;
   its score, explanation, rubric and 3/10 threshold remain available. The empty
   grid row is removed. The [intermediate mobile capture](docs/reviews/lesson-workspace-2026-10-31/screenshots/before-mobile-spacing.png) is retained; the final
   mobile captures show the corrected spacing and complete save choices.
4. **P2, responsive focus — fixed during technical review.** Widening could hide
   a focused mobile tab or readiness summary before the resize handler inspected
   focus. The editor now remembers a control hidden by CSS and focuses its
   visible destination after the layout commits. Both tabs, readiness and View
   preview are covered. Narrowing preserves focused readiness guidance. The new
   regression failed on the prior code and passed after correction in Chromium
   and WebKit; the reviewer independently confirmed the transitions and ordinary
   blur/external-focus cases. See the [review handoff](docs/reviews/lesson-workspace-2026-10-31/README.md).

The final comparison was performed after these changes and the resulting build.
The actions for long lessons remain at the end of the content in the page's normal
scrolling flow; the browser tests scroll there and check that both choices are
visible and unobstructed.

## Required fidelity surfaces

- **Fonts and typography:** retained Geist for interface text and user messages,
  with the established system serif for assistant replies and lesson prose.
  Preview headings use sans-serif hierarchy, and the lesson title stays visually
  dominant. Long text wraps without horizontal page overflow. Browser font
  rasterization and the generated reference's exact font metrics differ.
- **Spacing and layout:** the desktop setup row, paired workspace, review boundary
  and adjacent save choices match the proposed grouping. Narrow layouts devote
  the available width to the selected panel and use full-width save buttons.
  Mobile retains the actual conversation history and readiness disclosure, so
  its scroll length can exceed the abbreviated sample in the concept.
- **Colors and tokens:** uses the existing purple admin palette, semantic success
  and warning colors, outlines, radii and theme tokens. “Needs refresh” has a text
  label and warning icon; the disabled update has a lock icon and explanatory
  copy. Dark mode uses existing contrasting tokens rather than colors sampled
  from the light-only reference.
- **Image quality and assets:** uses the existing Plato logo and installed Lucide
  icons. These screens require no new illustration or raster artwork. The concept
  board, phone frames and sample avatar are not application assets. Existing
  desktop navigation remains intact; no replacement imagery was fabricated.
- **Copy and content:** distinguishes confirmed conversation saves, currently
  saved content, a current but unapplied preview, and unconfirmed final saves.
  “Refresh preview” is separate from “Update lesson.” The preview renders the
  actual markdown, including its required `Can …` objectives and authored list
  formatting, rather than silently rewriting it into the concept's numbered
  sample. After a confirmed update, the existing lesson-list status says
  “Lesson updated.”

## Interaction and verification

- Keyboard tab selection with arrow keys, Home and End; named controls and
  tab/panel relationships; View preview focus; focus retained across resizing.
- Composer text and preview retained across tabs and enlarged-text layouts.
- Stale public previews cannot update the lesson or trigger extraction through
  the disabled update control.
- Refreshing and failed extraction keep the saved lesson visible. A refresh
  started before a new conversation turn remains stale when it finishes.
- A background refresh does not steal focus from the composer; a hidden chat
  reply does not scroll the mobile review.
- Lost-response recovery preserves the chosen visibility, reviewed markdown and
  operation identity. Retrying the save does not call AI again.
- Readiness at 2, 3 and 8 preserves the existing 3/10 creation threshold.
- Sample-flow console checks found no application errors. WebKit's existing
  `interactive-widget` viewport-hint warning is explicitly excluded from that
  application-error assertion; other console errors remain failures.

Validation results:

| Check | Result |
| --- | --- |
| Client unit suite | 708 passed |
| Server suite | 889 passed; 3 environment-dependent tests skipped |
| Chromium authoring/publishing browser suite | 25 passed |
| WebKit authoring/publishing browser suite | 25 passed |
| Existing admin responsive browser suite | 24 passed |
| Client/server lint | No errors; 19 client warnings |
| Client production build | Passed; existing large-chunk advisory |
| Diff whitespace check | Passed |

Optional PostgreSQL integration tests and the Firestore emulator suite were not
enabled. Browser checks are emulation evidence, not physical-device or spoken
screen-reader qualification. Live AI and production Cloud SQL were not exercised.

## Implementation checklist

- [x] Paired desktop layout with setup above and save choices after review.
- [x] Mobile Refine / Preview tabs without remounting authoring state.
- [x] Explicit saved/current/stale/unconfirmed states and separate refresh action.
- [x] Preserve exact-preview saving and persistence-only recovery.
- [x] Render, compare, correct and recapture the selected concepts.
- [x] Run behavior, responsive, unit, lint and build checks.
- [x] Update the authoring architecture documentation.

No P3 refinements are required for this implementation. Remaining differences
are the existing product shell, authored markdown and the extra information
needed for a working editor, as described above. This report records local qualification; Git publication and release status are recorded in the [review handoff](docs/reviews/lesson-workspace-2026-10-31/README.md).
