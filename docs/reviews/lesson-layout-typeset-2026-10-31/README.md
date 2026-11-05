# Lesson layout, distill and typeset refinement — 2026-10-31

The user requested Impeccable `layout`, `distill` and `typeset` after approving the single-page publishing flow and the four mobile critique fixes. This pass refines those same lesson editor and lesson management surfaces.

The task path remains: define the lesson, review its generated content, then save privately or explicitly publish. Course and readiness belong together as setup; conversation and preview form the working area; finishing choices follow the preview. Geist remains the interface and preview family, with the existing serif coach voice. Metadata is compact, while prose retains comfortable leading.

## Changes

- Course/readiness and conversation/preview use aligned columns when the lesson container has at least 52 rem of available width. They stack in DOM order as available width or text size requires. Working sections use 24 px gaps; setup metadata uses a tighter 16 px row gap.
- The conversation's tinted enclosing card is removed. Its heading rule and aligned content provide structure, while the composer keeps its input boundary and the preview keeps one fine review boundary.
- Routine review guidance becomes secondary text on the lesson surface. Errors, stale-preview guidance, saving status and recovery controls retain their existing state behavior and wording.
- Section headings use 16 px / 600, generated preview titles retain 20 px / 600, and editor actions use 14 px / 500. Preview body text stays at 16 px, with 1.625 leading and a 65 ch maximum measure that shrinks to the available column. All sizes use rem or existing relative utilities.
- Mobile lesson titles use the documented 16 px / 600 role. Visibility and course share a wrapping metadata row. The named Actions menu has a quiet ghost trigger without the redundant ellipsis icon; its options and confirmation/focus behavior remain available.
- Stacked previews follow the page at intermediate widths as well as narrow phones. Wide previews retain their bounded inner scroll region. Preview styling is scoped to the lesson editor; the shared knowledge-base preview retains its existing defaults.

## Verification

| Check | Result |
| --- | --- |
| `npm run test:client` | 708 passed; no failures or skips. |
| `npm --prefix client run test:browser:publishing` | Chromium: 18 passed, including visibility, exact reviewed-content saving, pending/unknown outcomes, rejection, conflict, keyboard sharing, readiness and mobile finishing checks. |
| `npm --prefix client run test:browser:admin` | Chromium: 24 passed, including enlarged text, labelled navigation, filters, menu/dialog focus and responsive admin behavior. |
| Targeted publishing tests with `PLATO_TEST_BROWSER=webkit` | 4 passed: short/long mobile previews, readiness gate, mobile row interactions and real local API publishing. |
| Disposable rendered stress probe | 20 editor/list combinations passed: 320, 390, 768, 1024 and 1280 px; light/dark; 100%/200% root text size; long lesson/course names and long preview content. No page overflow; stacked previews had no inner content scroll. |
| Computed typography and contrast | Body/section/title/action sizes followed 16/16/20/14 px roles and doubled with text scaling. Routine guidance contrast ranged from 7.46:1 to 9.10:1 across the sampled themes. |
| `npm run build:client` | Passed; existing bundle-size advisory remains. |
| `npm --prefix client run lint` | Passed with no errors and 19 existing warnings. |
| Impeccable layout/type scans, before and after | Both scopes returned `[]`; no unexplained mechanical findings. |
| `git diff --check` | Passed. |

The stress probe reuses the existing authenticated browser fixtures against the real built client and a disposable SQLite server. Generated preview text and lesson/course records are synthetic. No paid model calls or production writes were made. Logs, the disposable probe, computed measurements and captures are under `output/playwright/lesson-layout-typeset/`.

## Layout and type evidence

| Concern | Evidence and interpretation |
| --- | --- |
| Reading order and grouping | The ordinary desktop capture shows setup above aligned working columns. Mobile captures retain conversation → preview → save choices in source and focus order. Plain routine guidance lets the generated lesson title lead. |
| Rhythm and structure | `.lesson-editor-columns` supplies a 24 px structural gap; `.lesson-editor-setup` tightens its row gap to 16 px. The conversation has a heading rule, the preview a single boundary, and the composer its functional input boundary. |
| Density | Mobile rows group status/course and retain optional metrics. The narrow editor's preview begins at roughly the previous position; no materially shorter mobile authoring journey is claimed. |
| Adaptation and extremes | The 20-combination probe covers long content, long titles/course names and 200% text. All combinations fit horizontally; all 18 stacked combinations used page-flow previews. Existing publishing/admin browser tests cover empty results, overlays, focus restoration, errors and recovery. |
| Authority and hierarchy | `DESIGN.md`, the existing Geist Variable asset and the system-serif coach role remain authoritative. Computed values confirm stable rem-based roles rather than new font assets or fluid display typography. |
| Reading measure and wrapping | `.lesson-editor-preview .coach-copy` caps measure at 65 ch and uses 1.625 leading. Narrow columns use their available width. Existing balanced markdown headings, pretty prose wrapping and long-token wrapping remain; unsupported text wrapping enhancements fall back to normal browser wrapping. |
| Delivery | No font or dependency changes. Existing variable-font delivery and fallback families remain. No JavaScript typography/layout dependency was introduced. |
| Final rendered review | The independent layout/type assessor inspected ordinary and stress captures and source, found the spatial/type thesis satisfied, and reported no material visual regression. |

## Comparisons

- Desktop editor: [before](../../../output/playwright/lesson-layout-typeset/before-editor-1280-light.png) · [after](../../../output/playwright/lesson-layout-typeset/after-editor-1280-light.png).
- Mobile lesson list: [before](../../../output/playwright/lesson-layout-typeset/before-list-320-private.png) · [after](../../../output/playwright/lesson-layout-typeset/after-list-320-private.png).
- Mobile review end: [before](../../../output/playwright/lesson-layout-typeset/before-review-end-dark-short.png) · [after](../../../output/playwright/lesson-layout-typeset/after-review-end-dark-short.png).
- [Long desktop preview](../../../output/playwright/lesson-layout-typeset/chromium/editor-1280-light-1x.png), [long mobile title/course](../../../output/playwright/lesson-layout-typeset/chromium/list-320-dark-1x.png), and [200% text at 768 px](../../../output/playwright/lesson-layout-typeset/chromium/editor-768-dark-2x.png).

## Preservation and limits

A verified recovery archive preserves all 25 pre-existing working files, Git identity/staged state and four before captures. All 20 files outside this pass match their before hashes. Editor state/persistence logic and preview async logic match the before version; shared CSS outside the authoring block is identical. The save queue, sharing modal, server code/tests, navigation, filters and existing browser tests were not changed by this pass.

Changes remain local and uncommitted on `feat/lesson-publishing`. Nothing was pushed or deployed. Chromium/WebKit and emulated widths provide browser evidence; physical devices, mobile browser chrome, hardware safe areas, and spoken screen-reader behavior remain unverified. The prior critique's historical score has not been reassessed.
