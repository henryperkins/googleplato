# Logo-derived classroom colors

The Customizer now samples each uploaded or saved logo, offers its colors as editable primary/accent suggestions, and generates separate readable light and dark roles. The dark header uses charcoal with a small brand undertone. This replaces the earlier deeply colored header that could make a chosen primary look muddy. The implementation applies to arbitrary supported logos and existing saved colors; it has no classroom-specific color rules.

## Behavior

- PNG, JPEG, WebP, and SVG continue through the existing bounded upload path. Color analysis runs locally on the prepared image or a same-origin saved asset. It clusters similar pixels, excludes transparent padding and small noise, and presents up to five swatches.
- Chromatic colors rank ahead of a neutral background or wordmark. **Use logo colors** favors a candidate with at least 3:1 against white for the primary when one exists, then selects a distinct logo hue for the accent. A single hue or monochrome logo matches its primary. Single-color pale logos retain their source color and receive derived readable interface roles.
- Uploading and analyzing never replace manually entered colors. Applying suggestions stages a draft. The existing Save, Discard, Reset, navigation protection, and selective update behavior remain in effect. Analysis failure and retry do not prevent manual edits or saving. Obsolete analysis is cancelled, and each result belongs to its source image.
- Each swatch has a hex-code accessible name, pressed state, visible selection marker, keyboard activation, and a 44px target. Selecting an accent swatch explicitly makes it independent of the primary.
- Transparent marks receive a light, charcoal, or middle-gray backing selected to maximize contrast for the weakest sampled color. The shared logo component uses this in previews, the classroom, and authentication pages. Logo bytes, colors, and proportions are preserved. Opaque logos retain their own background; canvas failures preserve the image and the existing name fallback.
- The learner's saved or device-driven light/dark preference remains authoritative.

## Palette rules

| Role | Derivation |
| --- | --- |
| Light header | Selected primary with a contrasting foreground; pale-header guidance remains visible. |
| Dark header and authentication backdrop | OKLCH lightness 0.32 and chroma at most 0.008, using the primary hue as a faint undertone. Achromatic brands remain neutral. |
| Dark primary fills | Lightness capped at 0.72, chroma at 0.18, with lightness adjusted to retain at least 3:1 against the dialog surface. |
| Dark learner messages | A restrained fill with white text at least 4.5:1 and a boundary at least 3:1 against the dialog surface. |
| Dark links and primary text | Starting lightness capped at 0.82 and chroma at 0.14, then adjusted for readable contrast. |
| Primary button hover | The checked fill/foreground pair is preserved; an underline supplies feedback. |
| Preview color changes | Inert sample buttons change colors immediately to avoid showing interpolated, unverified pairs. |

The preview's disclosure reports header text, button text, message text, links, focus rings, and button boundaries using the emitted colors. Pass/fail decisions use unrounded ratios. The targets follow [WCAG 2.2 text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). This is color-pair validation, not whole-page accessibility certification. The palette's saturation and brightness bounds express visual comfort and style, not a medical claim.

## Verification

**Code:** All 783 client tests pass, including palette selection, alpha handling, monochrome/pale/dark/neon examples, image-noise clustering, distinct hue selection, neutral logo backing, and a 216-pair primary/accent sweep in both modes. Before publication, the server suite also passed: 936 tests, with three environment-dependent tests skipped (two PostgreSQL suites and the production-start HTTP observability check). The production client build passes. Client lint has zero errors and 17 existing warnings; changed-file lint is clean. The design detector reported only four existing typography advisories on unchanged lines of `index.css`.

**Render:** The complete 38-test Chromium Customizer suite and six focused WebKit checks passed. After the final recommendation and immediate-preview refinements, the three affected logo scenarios were rerun in each engine. Coverage includes deliberate application, keyboard swatch selection, independent accents, saving/reloading, classroom/preview parity, failure/retry, transparent marks, 320px and 390px layouts, and 200% text. Existing upload, unsafe-SVG, persistence, knowledge-editor, and theme-preference regressions remain covered by the full suite.

The public Plato Shaped logo and public colors were copied to a disposable local SQLite instance for a recognizable visual comparison. The actual sign-in button's hovered text measured **4.60:1 in dark mode** and **4.70:1 in light mode**, with `:hover` and the underline verified. The temporary database and server were removed after capture. No production settings were written.

Representative screenshots and measured ratios are retained with this record:

- [Existing production dark sign-in](logo-derived-themes-2026-11-06/dark-before.png)
- [Updated dark sign-in, local](logo-derived-themes-2026-11-06/dark-after-local.png)
- [Customizer with the logo suggestion staged, local](logo-derived-themes-2026-11-06/customizer-local.png)
- [Phone preview with a saturated synthetic logo](logo-derived-themes-2026-11-06/phone-local.png)
- [Rendered hover ratios](logo-derived-themes-2026-11-06/rendered-hover-checks.json)

Additional browser captures remain in the local `output/playwright/logo-color-themes/` evidence folder.

**Limits:** No physical-device, screen-reader, PostgreSQL, production deployment, or medical outcome qualification was performed. A complex image can contain fine details beyond the sampled palette; the Customizer explicitly asks the administrator to inspect the logo in both previews. This change adds no storage schema, external analysis service, or dependency.
