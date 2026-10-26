# Classroom Customizer & Experience Review — 2026-10-26

## 1. Baseline & Verification Summary

- **Repository & Branch**: `/home/ubuntu/googleplato` on branch `fix/coach-assessment-contract`
- **Commit Reviewed**: `32f57481e629cddb833b50e1940d63d54e24da75` (`Merge admin AI settings refinement into main`), including `e2ce942` (`Fix classroom customization and branding`), `67b642a` (admin AI settings refinement), and `d8a4718` (`fix/admin-mobile-nav`).
- **Pre-existing Working-Tree State (Preserved Untouched)**:
  - Modified tracked files: `.gitignore`, `client/js/aiService.js`, `client/js/coach.js`, `client/js/prompts.js`, `client/js/storage.js`, `client/js/sync.js`, `client/src/pages/LessonChat.jsx`, `client/src/pages/LessonsList.jsx`, `client/src/pages/Settings.jsx`, `client/test/coach.test.js`, `client/test/lessonChat.test.js`, `client/test/sync.test.js`, `server/dev-sqlite.js`, `server/prompts/coach.md`, `server/src/index.js`, `server/src/lib/db-dynamodb.js`, `server/src/lib/db-postgres.js`, `server/src/lib/db-sqlite.js`, `server/src/lib/db.js`, `server/src/lib/lesson-visibility.js`, `server/src/routes/ai.js`, `server/src/routes/content.js`, `server/src/routes/sync.js`, `server/test/ai.test.js`, `server/test/content.test.js`, `server/test/db.test.js`, `server/test/sync-SmartSave.test.js`, `server/test/sync.test.js`.
  - Pre-existing untracked files: `client/js/coachTurn.js`, `client/test/browser/learner-mobile.browser.test.js`, `docs/reviews/`, `output/playwright/2026-10-25/`, `server/src/lib/coach-receipt.js`, `server/src/lib/lesson-coaching.js`, `server/src/lib/turn-lock.js`, `server/test/coach-turn.test.js`.
- **Automated Verification Executed (`Code`, `Render`, `Device`)**:
  - `npm run lint`: Passed (`0 errors, 20 warnings` in `client`; `0 errors, 0 warnings` in `server`).
  - `node scripts/validate-plugins.js`: Passed (`✓ Valid plugins: slack, teacher-comments, wordpress-info`).
  - `npm test`: Passed (`client`: 586 tests across 103 suites, 0 failures; `server`: 746 tests across 128 suites, 744 passing, 2 skipped, 0 failures).
  - `npm run build:client`: Passed (`vite build` succeeded; emitted a 551.06 kB main bundle chunk warning).
  - `npm --prefix client run test:browser:customizer` (Chromium): Passed (`10/10`).
  - `PLATO_TEST_BROWSER=webkit npm --prefix client run test:browser:customizer` (WebKit): Passed (`10/10`).
  - `npm --prefix client run test:browser:admin` (Chromium): Passed (`15/15`).
  - `npm --prefix client run test:browser:learner` (Chromium): Passed (`12/12`).

---

## 2. Verification of Prior Remediation Items (`docs/reviews/classroom-customizer-remediation-2026-10-25.md`)

| # | Prior Finding (2026-10-25) | Current Status | Verification Evidence (`Code`, `Render`, `Device`) |
| :--- | :--- | :--- | :--- |
| 1 | Public branding payload size & logo delivery (`GET /v1/branding` returning inline base64) | **Verified fixed** (`Code`, `Render`) | [`server/src/lib/branding.js`](file:///home/ubuntu/googleplato/server/src/lib/branding.js#L131-L163) and [`server/src/routes/content.js`](file:///home/ubuntu/googleplato/server/src/routes/content.js#L57-L84) now serve `/v1/branding` as a compact JSON payload (`{ theme, classroomName, logoUrl }`) with `Cache-Control: no-cache`, while `/v1/branding/logo/:hash` serves the binary asset with `Cache-Control: public, max-age=31536000, immutable`, `ETag`, `X-Content-Type-Options: nosniff`, and a sandboxed CSP. |
| 2 | Theme variables not reaching Radix portal overlays (`Dialog`, `AlertDialog`, `DropdownMenu`) | **Verified fixed** (`Code`, `Render`) | [`applyThemeVarsToRoot()`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L234-L253) applies `.classroom-theme` and CSS custom properties directly to `document.documentElement` (`:root`), so portaled dialogs and menus inherit the active classroom theme. |
| 3 | Unsaved changes protection, discard, and staged reset in `AdminStyles` | **Verified fixed** (`Code`, `Render`) | [`AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L40-L82) uses `useBlocker` and `beforeunload` when `dirty \|\| busy`, provides a `Discard changes` button, and stages `Reset to defaults` (`#8b1a1a`, `Plato`, `matchPrimary: true`, `logoBase64: null`) in draft state requiring explicit `Save`. |
| 4 | Independent loading/error states for `Styles` and `Knowledge` tabs | **Verified fixed** (`Code`, `Render`) | [`AdminCustomizer.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminCustomizer.jsx#L46-L90) fetches `/v1/admin/theme` and `/v1/admin/knowledge-base` via separate `useResource` hooks, rendering independent `ResourceState` boundaries with per-tab `Try again` buttons. |
| 5 | Logo upload hardening (SVG sanitization, `viewBox`-only SVG sizing, raster downscaling, stale upload epoch, repeat file selection) | **Verified fixed** (`Code`, `Render`, `Device`) | [`logoUpload.js`](file:///home/ubuntu/googleplato/client/src/lib/logoUpload.js#L15-L120) and [`server/src/lib/branding.js`](file:///home/ubuntu/googleplato/server/src/lib/branding.js#L15-L129) sanitize SVG (blocking `<script>`, `<foreignObject>`, event handlers, external `href`, `@import`, external `url()`), synthesize dimensions from `viewBox` (verified in WebKit), downscale rasters to `<=400x120`, guard async completion with `uploadEpoch`, and clear `input.value = ''`. |
| 6 | Incomplete hex typing stability and 3-digit shorthand normalization | **Verified fixed** (`Code`, `Render`) | [`AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L56-L69) updates live preview only when `/^#[\da-f]{6}$/i` matches while typing and normalizes 3-digit shorthand on blur or `Save`. |
| 7 | `Match primary` checkbox persistence for existing classrooms with a single color | **Partially addressed** (`Code`, `Render`) | `stylesFrom()` ([`AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L15-L20)) correctly initializes `matchPrimary: !theme.accent \|\| accent === primary`. However, editing `primary` while `Match primary` is checked does not sync `draft.accent`, so unchecking `Match primary` unexpectedly snaps the accent input back to the old pre-match accent color (see **Finding 5**). |
| 8 | Side-by-side Light and Dark previews isolated from admin theme | **Verified fixed** (`Code`, `Render`) | [`CustomPreviewCard`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L96-L157) renders explicit light (`bg-[#f8f7fa]`) and dark (`bg-[#17151c]`) preview cards with real `<Card>` and `<Button>` components and computed contrast variables, remaining accurate regardless of whether the admin console is in light or dark mode. |
| 9 | Device theme preference (`prefers-color-scheme`) vs. explicit user override (`plato_theme`) | **Partially addressed** (`Code`, `Render`) | [`ThemeContext.jsx`](file:///home/ubuntu/googleplato/client/src/contexts/ThemeContext.jsx#L10-L60) and [`client/index.html`](file:///home/ubuntu/googleplato/client/index.html#L10-L24) follow `prefers-color-scheme` until `ThemeToggle` writes `localStorage.setItem('plato_theme', next)`. However, `ThemeToggle` is missing on 6 of 7 public/onboarding pages (`/signup`, `/waitlist`, `/forgot-password`, `/reset-password`, `/privacy`, `/setup`), and there is no UI option to reset back to automatic device-following once `plato_theme` is set (see **Finding 8**). |

---

## 3. Confirmed Findings (Ordered by User Impact)

### Finding 1 — [High] Saving Styles in Customizer Leaves `BrandingContext` Stale When Returning to the Classroom via SPA Navigation (`Code`, `Render`)

- **Severity**: **High** — Directly breaks the core Customizer workflow (`Styles -> Save -> return to classroom`) whenever the administrator navigates via React Router or browser history instead of performing a full document reload.
- **Affected Workflow / Screen / Theme / Viewport**: `/lessons` -> `Admin Dashboard` (`/plato`) -> `Customizer` (`/plato/customizer`) -> `Save` -> browser Back or SPA link back to `/lessons` (all themes and viewports).
- **Reproduction Steps**:
  1. Sign in as an admin and open `/lessons` (classroom name `"Plato"`, primary `#8b1a1a`).
  2. Click `Admin Dashboard` in the classroom header ([`AppShell.jsx`](file:///home/ubuntu/googleplato/client/src/components/AppShell.jsx#L75-L83) calls `e.preventDefault(); navigate('/plato')`), then click `Customizer` (`/plato/customizer`).
  3. Change `Classroom Name` to `"Bauhaus Design Studio"`, set `Primary color` to `#1d4ed8`, upload a logo, and click `Save`. Wait for `"Saved."`.
  4. Press browser Back twice (or navigate via SPA router) to return to `/lessons`.
- **Actual vs. Expected Behavior**:
  - **Actual**: [`AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L139) calls `invalidatePublicBranding(result.branding || null)`, which updates `sessionStorage` (`plato_branding`), **but** [`BrandingProvider`](file:///home/ubuntu/googleplato/client/src/contexts/BrandingContext.jsx#L19-L87) wraps the entire `<BrowserRouter>` in [`App.jsx`](file:///home/ubuntu/googleplato/client/src/App.jsx#L103-L109) and only reads `sessionStorage` on initial mount (`useState(() => readCachedBranding())`) and only runs its fetch `useEffect` when `[authLoading, Boolean(user)]` changes. Because `BrandingProvider` never unmounts during SPA navigation and does not subscribe to `invalidatePublicBranding`, returning to `/lessons` renders the **old** classroom name (`Lessons — Plato`), **old** `#8b1a1a` header, and **old** logo until the user manually refreshes the browser.
  - **Expected**: Saving in `AdminStyles` should immediately update `BrandingContext` state (or trigger a listener in `BrandingProvider`) so any subsequent SPA navigation or browser Back to `/lessons` reflects the newly saved brand immediately.
- **Evidence**:
  - Code: [`client/src/contexts/BrandingContext.jsx`](file:///home/ubuntu/googleplato/client/src/contexts/BrandingContext.jsx#L31-L87), [`client/src/pages/admin/AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L133-L141), [`client/src/hooks/usePublicBranding.js`](file:///home/ubuntu/googleplato/client/src/hooks/usePublicBranding.js#L13-L23).
- **Concrete Recommendation**:
  - Dispatch a custom window event (e.g., `window.dispatchEvent(new CustomEvent('plato:branding-updated', { detail: branding }))`) inside `invalidatePublicBranding(branding)` in [`usePublicBranding.js`](file:///home/ubuntu/googleplato/client/src/hooks/usePublicBranding.js#L13-L23) and listen for it in [`BrandingProvider`](file:///home/ubuntu/googleplato/client/src/contexts/BrandingContext.jsx#L38-L87) to update `theme`, `logoBase64`, and `classroomName` in memory immediately.
- **Acceptance Criterion**:
  - Navigating `/lessons` -> `Admin Dashboard` -> `Customizer` -> `Save` -> browser Back to `/lessons` updates the header color, logo, and `document.title` without requiring a page reload.

---

### Finding 2 — [High] Very Light & Pale Brand Colors Produce Near-Invisible Primary Buttons, User Chat Bubbles, and Progress Bars in Light Mode (`Code`, `Render`)

- **Severity**: **High** — Breaks visual hierarchy and fails WCAG 2.2 AA `1.4.11 Non-text Contrast` (`3:1` minimum for UI component boundaries and state indicators) across all learner screens in light mode when a light brand color is configured.
- **Affected Workflow / Screen / Theme / Viewport**: `/lessons`, `/lessons/:lessonId`, `/settings`, and public auth pages in **Light mode** under light or high-luminance primary colors (`#f8fafc`, `#bae6fd`, `#eab308`).
- **Reproduction Steps**:
  1. In `/plato/customizer`, set `Primary color` to `#f8fafc` (or `#bae6fd` / `#eab308`) and click `Save`.
  2. Open `/lessons` and `/lessons/:lessonId` in Light mode (`localStorage.setItem('plato_theme', 'light')`).
- **Actual vs. Expected Behavior**:
  - **Actual**: While dark mode uses [`darkFillColor(primary)`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L156-L169) to guarantee `>= 3.0:1` fill contrast against dark cards, light mode in [`buildThemeVars()`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L204-L206) assigns the raw, unadjusted `primary` color to `--primary: hexToOklch(primary)` with no border on primary buttons, user chat bubbles, or progress bar fills:
    - With `#f8fafc` (very light): Primary button fill (`Send`, `Save`, `Sign in`) against a `#ffffff` card is **`1.05:1`**; user chat bubble fill on `#ffffff` is **`1.05:1`**; lesson progress bar fill (`#progress-bar-fill.bg-primary`) against `.bg-muted` (`#f5f5f5`) is **`1.04:1`** (invisible).
    - With `#bae6fd` (pale blue): Primary button fill on `#ffffff` is **`1.33:1`**; progress bar fill on `#f5f5f5` is **`1.22:1`**.
    - With `#eab308` (saturated yellow): Primary button fill on `#ffffff` is **`1.92:1`**; progress bar fill on `#f5f5f5` is **`1.76:1`**.
    - Even in **dark mode** with `#1d4ed8` (ordinary blue), [`DARK_CARD`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L139) is hardcoded as `#171717`, whereas actual dark `.classroom-theme` cards are tinted (`~#191b24`) and `.bg-muted` progress tracks are `~#252731`, yielding **`2.77:1`** button-on-card contrast and **`2.44:1`** progress-fill-on-track contrast.
  - **Expected**: Interactive primary fills (`--primary`) and progress indicators should either be darkened in light mode via a `lightFillColor(primary)` helper (mirroring `darkFillColor` when contrast against `#ffffff`/`#f5f5f5` is `< 3:1`) or receive a contrasting border token when fill contrast against the surface is `< 3:1`.
- **Evidence**:
  - Code: [`client/src/lib/branding.js`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L139-L220), [`client/src/index.css`](file:///home/ubuntu/googleplato/client/src/index.css#L140-L185).
  - Screenshots: [lessons-very-light-match-light.png](file:///home/ubuntu/googleplato/output/playwright/2026-10-26/lessons-very-light-match-light.png), [chat-very-light-match-light.png](file:///home/ubuntu/googleplato/output/playwright/2026-10-26/chat-very-light-match-light.png), [lessons-default-maroon-light.png](file:///home/ubuntu/googleplato/output/playwright/2026-10-26/lessons-default-maroon-light.png), [chat-default-maroon-light.png](file:///home/ubuntu/googleplato/output/playwright/2026-10-26/chat-default-maroon-light.png).
- **Concrete Recommendation**:
  - Add a `lightFillColor(hex)` helper in [`client/src/lib/branding.js`](file:///home/ubuntu/googleplato/client/src/lib/branding.js) (or clamp `--primary` lightness in light mode against `#f5f5f5` to `>= 3.0:1` while keeping `--classroom-header-bg` as chosen or giving low-contrast headers/buttons a `1px` border), and update `DARK_CARD` from `#171717` to `#262626` so dark-mode fills also clear `3.0:1` against `.bg-muted` progress tracks.
- **Acceptance Criterion**:
  - Across all 7 representative brand palettes in both light and dark modes, primary buttons, user chat bubbles, and progress bar fills maintain `>= 3.0:1` non-text contrast against their surrounding card/track surface, and button/bubble labels maintain `>= 4.5:1` text contrast.

---

### Finding 3 — [High] Knowledge Base Editor Re-Extracts via AI on Save (Overwriting the Reviewed Preview), Shows a Misleading "Unsaved" Banner on Open, and Lacks Unsaved Navigation Protection (`Code`, `Render`)

- **Severity**: **High** — Causes silent content drift between what the administrator reviewed in the preview pane and what gets published to the classroom knowledge base, plus data loss on tab switching.
- **Affected Workflow / Screen / Theme / Viewport**: `/plato/customizer/knowledge/edit` (`KnowledgeBaseEditor.jsx` and `AdminCustomizer.jsx`), all themes and viewports.
- **Reproduction Steps**:
  1. Open `/plato/customizer/knowledge` on a classroom with an existing knowledge base and click `Edit Knowledge Base`.
  2. Observe the preview pane status banner immediately on open before making any edits.
  3. Send a message in the builder chat, click `Refresh preview`, and review the generated Markdown in `MarkdownPreviewPane`.
  4. Click `Update Knowledge Base` (or click the `Styles` tab before saving).
- **Actual vs. Expected Behavior**:
  - **Actual**:
    1. **Double AI extraction overwrites reviewed preview**: Unlike [`LessonEditor.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/LessonEditor.jsx#L172-L194) (which saves `current.previewMarkdown` directly when the preview is current), [`handleSaveKB()` in `KnowledgeBaseEditor.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/KnowledgeBaseEditor.jsx#L121-L138) unconditionally calls `extractKBMarkdown(...)` a second time on save, overwriting the exact Markdown the admin just reviewed in the preview pane with a newly generated LLM response.
    2. **Misleading warning banner on initial open**: [`KnowledgeBaseEditor.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/KnowledgeBaseEditor.jsx#L271-L282) never passes `saved={...}` to [`MarkdownPreviewPane`](file:///home/ubuntu/googleplato/client/src/components/admin/MarkdownPreviewPane.jsx#L12-L42). Because `saved` defaults to `false`, opening an already-saved KB immediately shows the amber warning banner: `"Review this preview, then choose “Update Knowledge Base” to save it."`
    3. **No unsaved navigation blocker**: Switching tabs to `Styles` or clicking `<- Back` immediately unmounts `KnowledgeBaseEditor` without a `useBlocker` / `beforeunload` prompt, discarding unsaved preview state or an in-flight AI turn.
    4. **Legacy readiness lock**: [`AdminCustomizer.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminCustomizer.jsx#L78) passes `initialReadiness={kb.readiness ?? 0}`. For existing KBs saved before `readiness` was persisted (where `kb.conversation` exists but `kb.readiness` is `undefined`), `saveBlocked` (`readiness < 3`) disables `Update Knowledge Base` on open (unlike [`LessonEditor.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/LessonEditor.jsx#L47), which falls back to `8` when existing content is present).
  - **Expected**: Saving when `previewMarkdown && !previewStale` should persist `previewMarkdown` directly without a second LLM call; `MarkdownPreviewPane` should receive `saved={Boolean(initialContent) && chatMessages.length === (initialConversation?.length ?? 0) && previewMarkdown === initialContent}`; `useBlocker` should guard unsaved edits; and `initialReadiness` should default to `8` when `kb.content` already exists.
- **Evidence**:
  - Code: [`client/src/pages/admin/KnowledgeBaseEditor.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/KnowledgeBaseEditor.jsx#L31-L138), [`client/src/pages/admin/AdminCustomizer.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminCustomizer.jsx#L61-L86).
  - Screenshot: [customizer-knowledge-editor-desktop.png](file:///home/ubuntu/googleplato/output/playwright/2026-10-26/customizer-knowledge-editor-desktop.png).
- **Concrete Recommendation**:
  - Align `KnowledgeBaseEditor.jsx` with `LessonEditor.jsx`: reuse `previewMarkdown` on save when `!previewStale`, pass `saved` to `MarkdownPreviewPane`, add `useBlocker` + `beforeunload` when conversation or preview has unsaved changes or `isBusy`, and pass `initialReadiness={kb.readiness ?? (kb.content ? 8 : 0)}` in `AdminCustomizer.jsx`.
- **Acceptance Criterion**:
  - Opening `Edit Knowledge Base` on an unchanged KB shows no unsaved warning banner; clicking `Refresh preview` then `Update Knowledge Base` makes exactly 1 extraction call and saves the reviewed Markdown verbatim; navigating away with unsaved KB turns prompts for confirmation.

---

### Finding 4 — [Medium] Markdown Rendering & Lesson Authoring Parity Gaps (`renderMd` vs. `parseLessonPrompt` vs. Learner Cards/Outlines) (`Code`, `Render`)

- **Severity**: **Medium** — Authors see formatted Markdown and multi-paragraph descriptions in `LessonEditor`’s preview pane, but learners see raw unparsed Markdown syntax (`**bold**`, `` `code` ``, `[link](url)`), truncated descriptions, and unformatted code blocks/blockquotes in chat and KB views.
- **Affected Workflow / Screen / Theme / Viewport**: `/plato/lessons/:id/edit`, `/plato/customizer/knowledge`, `/lessons` (`LessonCard` & `LessonDetailDialog`), and `/lessons/:lessonId` (`LessonChat` & outline modal).
- **Reproduction Steps**:
  1. Author a lesson whose description, exemplar, and learning objectives use inline Markdown (`**perceptual lightness**`, `` `OKLCH` ``, `[WCAG 2.2 contrast](https://www.w3.org/TR/WCAG22/)`) or a two-paragraph description, and whose coach messages or KB content include a blockquote (`> quote`) and fenced code block (```` ```js ````).
  2. Compare `/plato/lessons/:id/edit` (`MarkdownPreviewPane`) against `/lessons` (`LessonCard` and `View outline` dialog) and `/lessons/:lessonId` (`LessonChat` and `Lesson outline` dialog).
- **Actual vs. Expected Behavior**:
  - **Actual**:
    1. **Raw Markdown syntax on learner cards and outline dialogs**: [`LessonsList.jsx`](file:///home/ubuntu/googleplato/client/src/pages/LessonsList.jsx#L441-L445) (`LessonCard`), [`LessonsList.jsx`](file:///home/ubuntu/googleplato/client/src/pages/LessonsList.jsx#L583-L645) (`LessonDetailDialog`), and [`LessonChat.jsx`](file:///home/ubuntu/googleplato/client/src/pages/LessonChat.jsx#L353-L370) render `lesson.description`, `exemplar`, and `learningObjectives` as plain React text nodes, exposing literal `**`, `` ` ``, and `[text](url)` characters that rendered as formatted rich text in `LessonEditor`.
    2. **Silent description truncation**: [`parseLessonPrompt()` in `server/src/shared/lessonMarkdown.js`](file:///home/ubuntu/googleplato/server/src/shared/lessonMarkdown.js#L16-L36) captures only the *first* non-empty line after `# Title` (`if (currentSection === null && line.trim() && name && !description)`) and drops all subsequent description paragraphs. Worse, if an author writes a `## Description` heading, `currentSection` becomes `'other'` and `description` becomes `""` (empty), whereas `MarkdownPreviewPane` renders the entire document.
    3. **Missing code block, inline code, and blockquote rules in `renderMd()`**: Even though [`client/src/index.css`](file:///home/ubuntu/googleplato/client/src/index.css#L387-L395) defines `.coach-copy pre` styles, [`renderMd()` in `client/src/lib/helpers.js`](file:///home/ubuntu/googleplato/client/src/lib/helpers.js#L16-L104) has no parser rules for fenced code blocks (```` ``` ````), inline code (`` `code` ``), or blockquotes (`> `), rendering literal backticks and `> ` characters across coach chat, `KBViewer`, and `MarkdownPreviewPane`.
  - **Expected**: `renderMd()` should support fenced `<pre><code>`, inline `<code>`, and `<blockquote>`; `parseLessonPrompt()` should accept optional `## Description` headings and join multi-line descriptions; and learner outline/card surfaces should either strip or render inline Markdown consistently with the author preview.
- **Evidence**:
  - Code: [`client/src/lib/helpers.js`](file:///home/ubuntu/googleplato/client/src/lib/helpers.js#L16-L104), [`server/src/shared/lessonMarkdown.js`](file:///home/ubuntu/googleplato/server/src/shared/lessonMarkdown.js#L16-L48), [`client/src/pages/LessonsList.jsx`](file:///home/ubuntu/googleplato/client/src/pages/LessonsList.jsx#L441-L645).
  - Screenshots: [lesson-editor-preview-desktop.png](file:///home/ubuntu/googleplato/output/playwright/2026-10-26/lesson-editor-preview-desktop.png), [lesson-outline-modal-desktop.png](file:///home/ubuntu/googleplato/output/playwright/2026-10-26/lesson-outline-modal-desktop.png), [chat-default-maroon-light.png](file:///home/ubuntu/googleplato/output/playwright/2026-10-26/chat-default-maroon-light.png).
- **Concrete Recommendation**:
  - Add fenced code block, inline code, and blockquote handling to [`renderMd()`](file:///home/ubuntu/googleplato/client/src/lib/helpers.js#L16-L104); update [`parseLessonPrompt()`](file:///home/ubuntu/googleplato/server/src/shared/lessonMarkdown.js#L16-L36) to recognize `## Description` and preserve multi-line descriptions; and render inline formatting (or strip markdown tokens on clamped cards while rendering inline markdown in `LessonDetailDialog` / `LessonChat` outline).
- **Acceptance Criterion**:
  - Code blocks, inline code, and blockquotes render as semantic `<pre><code>`, `<code>`, and `<blockquote>` elements in `.coach-copy`, and learner cards/outlines never display raw `**` or `[label](url)` syntax.

---

### Finding 5 — [Medium] Unchecking "Match Primary" Reverts Accent to Stale Value, and `PUT /v1/admin/theme` Accepts Empty `{ theme: {} }` Explaining Default `#470d99` vs. `#8b1a1a` Drift (`Code`, `Render`)

- **Severity**: **Medium** — Causes surprising color jumps when customizing an accent color after changing the primary color, and allows empty `theme: {}` API payloads to wipe `primary` and expose conflicting fallback defaults (`#470d99` vs. `#8b1a1a`).
- **Affected Workflow / Screen / Theme / Viewport**: `/plato/customizer` (`AdminStyles.jsx`) and `PUT /v1/admin/theme` (`server/src/routes/admin.js`).
- **Reproduction Steps**:
  1. In `/plato/customizer`, save a theme with `primary: '#1d4ed8'` and `accent: '#eab308'` (unmatched).
  2. Check `Match primary`, then change `Primary color` to `#0f766e`. Observe that the disabled Accent input displays `#0f766e`.
  3. Uncheck `Match primary` to tweak the accent shade starting from `#0f766e`.
  4. Separately, send `PUT /v1/admin/theme` with `{ "theme": {}, "classroomName": "Test" }`.
- **Actual vs. Expected Behavior**:
  - **Actual**:
    1. In [`AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L56-L61), `changeColor('primary', value)` updates `draft.primary` without updating `draft.accent` when `draft.matchPrimary` is true. Unchecking `Match primary` (`onChange={event => change({ matchPrimary: event.target.checked, accent: event.target.checked ? draft.primary : draft.accent })}` at line 222) restores the stale `draft.accent` (`#eab308`) instead of keeping `#0f766e`.
    2. In [`server/src/routes/admin.js`](file:///home/ubuntu/googleplato/server/src/routes/admin.js#L1139-L1150), `PUT /v1/admin/theme` only validates `theme.primary` if `val !== undefined && val !== null`. Sending `{ theme: {} }` returns `200 OK` and persists `settings.theme = {}`.
    3. When `settings.theme` has no `primary`, [`stylesFrom()` in `AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L17) falls back to `DEFAULT_PRIMARY` (`#470d99` purple in [`client/src/lib/branding.js`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L3)), whereas `defaultStyles` (`Reset to defaults` in [`AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L12)), [`seed.js`](file:///home/ubuntu/googleplato/server/src/lib/seed.js#L92), and `DESIGN.md` use `#8b1a1a` (maroon).
  - **Expected**: Unchecking `Match primary` should initialize `draft.accent` to the current `draft.primary` (`accent: draft.primary`); `PUT /v1/admin/theme` should require a valid `theme.primary` whenever `body.theme` is provided; and fallback constants should agree on `#8b1a1a` (classroom default) vs. `#470d99` (fixed admin identity).
- **Evidence**:
  - Code: [`client/src/pages/admin/AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L12-L20), [`client/src/pages/admin/AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L219-L226), [`server/src/routes/admin.js`](file:///home/ubuntu/googleplato/server/src/routes/admin.js#L1139-L1156).
- **Concrete Recommendation**:
  - In `AdminStyles.jsx`, set `accent: draft.primary` when toggling `Match primary` either on or off (or keep `draft.accent` synced while `draft.matchPrimary` is true). In `server/src/routes/admin.js`, reject `body.theme` when `!body.theme.primary`.
- **Acceptance Criterion**:
  - Unchecking `Match primary` keeps the current primary hex in the accent input ready for adjustment, and `PUT /v1/admin/theme` with `{ theme: {} }` returns `400 Bad Request`.

---

### Finding 6 — [Medium] Classroom Custom Favicon Bleeds Onto Admin Console (`/plato/*`), Leaves the `16x16` `<link rel="icon">` Unchanged, and Can Leak on Unmount Race (`Code`, `Render`)

- **Severity**: **Medium** — Violates the documented branding boundary (`DESIGN.md`: `/plato/*` is fixed Plato default identity) and causes 1x DPI desktop tabs to ignore the custom classroom favicon.
- **Affected Workflow / Screen / Theme / Viewport**: Browser tab identity across `/lessons`, `/plato/*`, and public pages.
- **Reproduction Steps**:
  1. Save a custom logo or custom primary color in `/plato/customizer` and load `/lessons`.
  2. Inspect `document.querySelectorAll("link[rel='icon']")` in the DOM.
  3. Navigate to `/plato` (Admin Dashboard) and inspect `document.querySelectorAll("link[rel='icon']")`.
- **Actual vs. Expected Behavior**:
  - **Actual**:
    1. [`client/index.html`](file:///home/ubuntu/googleplato/client/index.html#L7-L8) declares two icon links: `<link rel="icon" type="image/png" sizes="32x32" href="/assets/icon-32.png" />` and `<link rel="icon" type="image/png" sizes="16x16" href="/assets/icon-16.png" />`. [`setFavicon()` in `client/src/lib/branding.js`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L287-L298) uses `document.querySelector("link[rel='icon']")`, mutating only the first tag (`32x32`) while leaving the `16x16` tag pointing to `/assets/icon-16.png`.
    2. Because [`BrandingProvider`](file:///home/ubuntu/googleplato/client/src/contexts/BrandingContext.jsx#L106-L120) stays mounted on `/plato/*` routes, its favicon effect remains active on `/plato/*`, displaying the custom classroom favicon instead of the fixed Plato admin favicon.
    3. In [`BrandingContext.jsx`](file:///home/ubuntu/googleplato/client/src/contexts/BrandingContext.jsx#L113-L116) and [`usePublicBranding.js`](file:///home/ubuntu/googleplato/client/src/hooks/usePublicBranding.js#L31-L34), `generateFavicon()` calls `setFavicon()` internally *before* resolving the promise (`if (!cancelled) restoreFn = restore;`). If the component unmounts while `loadImage()` is still decoding, `setFavicon()` runs after unmount and `restore()` is never called (`else if (restore) restore()` is missing).
  - **Expected**: `setFavicon()` should update/restore all `link[rel='icon']` elements; `/plato/*` routes should restore the default Plato favicon; and `if (cancelled) restore?.()` should clean up late async favicon completions.
- **Evidence**:
  - Code: [`client/index.html`](file:///home/ubuntu/googleplato/client/index.html#L7-L8), [`client/src/lib/branding.js`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L287-L298), [`client/src/contexts/BrandingContext.jsx`](file:///home/ubuntu/googleplato/client/src/contexts/BrandingContext.jsx#L106-L120).
- **Concrete Recommendation**:
  - Update `setFavicon()` to update all `document.querySelectorAll("link[rel='icon']")` tags and return a single cleanup function that restores each tag's original `href`; gate the custom favicon in `BrandingContext` to non-`/plato` routes; and call `else restore?.()` when `cancelled` is true in `.then(restore => ...)`.
- **Acceptance Criterion**:
  - Both `32x32` and `16x16` icon links update on learner/public routes and revert to `/assets/icon-32.png` and `/assets/icon-16.png` on `/plato/*`.

---

### Finding 7 — [Medium] Transparent Dark/Light Logo Wordmarks Can Lose Contrast Against Branded Headers Without Warning or Backdrop Option (`Code`, `Render`)

- **Severity**: **Medium** — Transparent PNG/SVG logos with dark ink become illegible on dark brand headers (`#8b1a1a` in light mode and `darkHeaderColor` in dark mode), while white transparent logos become illegible on very light brand headers (`#f8fafc` in light mode).
- **Affected Workflow / Screen / Theme / Viewport**: `/plato/customizer` previews, `AppShell` header, public auth headers, and transactional emails.
- **Reproduction Steps**:
  1. Upload a transparent PNG or SVG wordmark with dark text (`#111111`) on the default maroon brand (`#8b1a1a`), or upload a white wordmark (`#ffffff`) on a very light brand (`#f8fafc`).
- **Actual vs. Expected Behavior**:
  - **Actual**: A `#111111` transparent wordmark has **`1.44:1`** contrast against the `#8b1a1a` light-mode header and **`1.19:1`** contrast against the `#660d12` dark-mode header. Conversely, a `#ffffff` transparent wordmark has **`1.04:1`** contrast against a `#f8fafc` light-mode header and **`6.58:1`** against the `#5d5d5d` dark-mode header. `AdminStyles` provides no contrast warning for transparent logos and no optional light/dark logo pill backdrop.
  - **Expected**: Either offer an optional subtle backdrop pill behind transparent logos (or a dark-mode logo variant) or detect low luminance contrast on non-transparent logo pixels and surface a helpful note in `AdminStyles`.
- **Evidence**:
  - Code: [`client/src/pages/admin/AdminStyles.jsx`](file:///home/ubuntu/googleplato/client/src/pages/admin/AdminStyles.jsx#L109-L115), [`client/src/components/AppShell.jsx`](file:///home/ubuntu/googleplato/client/src/components/AppShell.jsx#L56-L61).
- **Concrete Recommendation**:
  - Add a simple checkbox or segmented option in the `Logo` card (e.g., `Add light backdrop behind logo` or automatic luminance check in `prepareLogo`) and mention in the upload hint that transparent logos appear over both the chosen primary header and its deepened dark-mode shade.
- **Acceptance Criterion**:
  - Administrators uploading a transparent dark or light logo can ensure `>= 3:1` legibility across both Light and Dark preview cards.

---

### Finding 8 — [Low] Public & Onboarding Surface Polish Gaps (`ThemeToggle` Missing on 6 Public Pages, Hardcoded `#470d99` on `/setup`, No Sign-Out or Fresh Profile Re-fetch on `ProfileCompletionGate`) (`Code`, `Render`)

- **Severity**: **Low** — Creates minor theme-control and onboarding inconsistencies across public/entry routes.
- **Affected Workflow / Screen / Theme / Viewport**: `/signup`, `/waitlist`, `/forgot-password`, `/reset-password`, `/privacy`, `/setup`, and `ProfileCompletionGate`.
- **Reproduction Steps**:
  1. Visit `/login` vs. `/waitlist`, `/forgot-password`, `/privacy`, `/signup`, `/reset-password`, and `/setup`.
  2. Configure a required custom user field (`userEditable: true`) in `/plato/users` and visit `/lessons` as a logged-in user whose cached `localStorage` (`plato_auth`) lacks that field.
- **Actual vs. Expected Behavior**:
  - **Actual**:
    1. `<ThemeToggle />` is present in the footer of [`Login.jsx`](file:///home/ubuntu/googleplato/client/src/pages/Login.jsx#L294), but is omitted from [`Signup.jsx`](file:///home/ubuntu/googleplato/client/src/pages/Signup.jsx), [`Waitlist.jsx`](file:///home/ubuntu/googleplato/client/src/pages/Waitlist.jsx), [`ForgotPassword.jsx`](file:///home/ubuntu/googleplato/client/src/pages/ForgotPassword.jsx), [`ResetPassword.jsx`](file:///home/ubuntu/googleplato/client/src/pages/ResetPassword.jsx), [`Privacy.jsx`](file:///home/ubuntu/googleplato/client/src/pages/Privacy.jsx), and [`Setup.jsx`](file:///home/ubuntu/googleplato/client/src/pages/Setup.jsx). Also, `ThemeToggle` only toggles `'light'` <-> `'dark'` with no way to return to automatic device-preference following once clicked.
    2. [`Setup.jsx`](file:///home/ubuntu/googleplato/client/src/pages/Setup.jsx#L121) hardcodes `style={{ backgroundColor: '#470d99' }}` instead of using semantic tokens (`bg-header text-header-foreground`).
    3. [`ProfileCompletionGate.jsx`](file:///home/ubuntu/googleplato/client/src/components/ProfileCompletionGate.jsx#L22-L120) checks `user?.customFields` from the login-time `localStorage` cache (`plato_auth`) without re-fetching `/v1/me` on mount, and renders a full-screen card with no `Sign out` button or `AppShell` header.
  - **Expected**: Include `<ThemeToggle />` consistently across public pages, replace hardcoded `#470d99` in `Setup.jsx` with `bg-header text-header-foreground`, and provide a `Sign out` action (and fresh `/v1/me` check) in `ProfileCompletionGate`.
- **Evidence**:
  - Code: [`client/src/pages/Login.jsx`](file:///home/ubuntu/googleplato/client/src/pages/Login.jsx#L294), [`client/src/pages/Setup.jsx`](file:///home/ubuntu/googleplato/client/src/pages/Setup.jsx#L121), [`client/src/components/ProfileCompletionGate.jsx`](file:///home/ubuntu/googleplato/client/src/components/ProfileCompletionGate.jsx#L22-L120).
- **Concrete Recommendation**:
  - Extract a shared public footer containing `Privacy Policy` and `<ThemeToggle />`, use semantic header classes in `Setup.jsx`, and add a `Sign out` button to `ProfileCompletionGate.jsx`.
- **Acceptance Criterion**:
  - Every public page offers the same footer theme toggle, `/setup` uses semantic header tokens in light and dark mode, and `ProfileCompletionGate` allows signing out.

---

## 4. Brand Contrast Matrix Across Representative Palettes (`Code`, `Render`)

Measured via [`buildThemeVars()`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L198-L231), [`contrastRatio()`](file:///home/ubuntu/googleplato/client/src/lib/branding.js#L37-L41), and computed DOM styles across Light (`#ffffff` card, `#f5f5f5` muted track) and Dark (`#1f1f1f` card, `#292929` muted track, `#161616` workspace):

| Brand Configuration | Mode | Header Text / Header (`>=4.5:1`) | Header / Workspace | Primary Btn Text / Fill (`>=4.5:1`) | Primary Btn Fill / Card (`>=3.0:1`) | Progress Fill / Track (`>=3.0:1`) | Primary Text / Card (`>=4.5:1`) | Link & Ring / Card (`>=4.5:1`) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Default Maroon** (`#8b1a1a`) | Light | `7.94:1` | `7.94:1` | `7.94:1` | `7.94:1` | `7.29:1` | `7.94:1` | `7.94:1` |
| **Default Maroon** (`#8b1a1a`) | Dark | `8.59:1` | `2.11:1` | `7.09:1` | `3.32:1` | `2.93:1` | `5.78:1` | `5.78:1` |
| **Ordinary Blue** (`#1d4ed8`) | Light | `6.70:1` | `6.70:1` | `6.70:1` | `6.70:1` | `6.15:1` | `6.70:1` | `6.70:1` |
| **Ordinary Blue** (`#1d4ed8`) | Dark | `6.97:1` | `2.60:1` | `5.96:1` | **`2.77:1`** ⚠️ | **`2.44:1`** ⚠️ | `5.79:1` | `5.79:1` |
| **Very Light** (`#f8fafc`, match) | Light | `16.63:1` | **`1.05:1`** ⚠️ | `16.63:1` | **`1.05:1`** ❌ | **`1.04:1`** ❌ | `5.03:1` | `5.03:1` |
| **Very Light** (`#f8fafc`, match) | Dark | `6.58:1` | `2.75:1` | `16.63:1` | `15.75:1` | `13.90:1` | `15.75:1` | `15.75:1` |
| **Very Light + Blue Accent** (`#f8fafc` / `#1d4ed8`) | Light | `16.63:1` | **`1.05:1`** ⚠️ | `16.63:1` | **`1.05:1`** ❌ | **`1.04:1`** ❌ | `5.03:1` | `6.70:1` |
| **Very Light + Blue Accent** (`#f8fafc` / `#1d4ed8`) | Dark | `6.58:1` | `2.75:1` | `16.63:1` | `15.75:1` | `13.90:1` | `15.75:1` | `5.79:1` |
| **Very Dark** (`#09090b`) | Light | `19.90:1` | `19.90:1` | `19.90:1` | `19.90:1` | `18.25:1` | `19.90:1` | `19.90:1` |
| **Very Dark** (`#09090b`) | Dark | `12.27:1` | `1.48:1` | `14.20:1` | `13.45:1` | `11.87:1` | `5.79:1` | `5.79:1` |
| **Saturated Yellow** (`#eab308`) | Light | `9.08:1` | `1.92:1` | `9.08:1` | **`1.92:1`** ❌ | **`1.76:1`** ❌ | `5.03:1` | `5.03:1` |
| **Saturated Yellow** (`#eab308`) | Dark | `6.56:1` | `2.76:1` | `9.08:1` | `8.59:1` | `7.59:1` | `8.59:1` | `8.59:1` |
| **Pale Blue + Pale Yellow** (`#bae6fd` / `#fef08a`) | Light | `13.12:1` | `1.33:1` | `13.12:1` | **`1.33:1`** ❌ | **`1.22:1`** ❌ | `5.04:1` | `5.03:1` |
| **Pale Blue + Pale Yellow** (`#bae6fd` / `#fef08a`) | Dark | `6.49:1` | `2.79:1` | `13.12:1` | `12.42:1` | `10.96:1` | `12.42:1` | `14.16:1` |

*Note on Semantic Status Tokens (`Code`, `Render`)*: Semantic status tokens (`--success`, `--warning`, `--danger`, `--in-progress-background`, `--completed-background` in [`client/src/index.css`](file:///home/ubuntu/googleplato/client/src/index.css#L75-L138)) are fixed OKLCH values independent of classroom brand colors and maintain `>= 5.2:1` icon/text contrast in both light and dark modes across all 7 brands.

---

## 5. Compact Inventory of Appearance Controls & Rendering Systems

| Control / System | Controller | Configured & Persisted In | Affected Screens / Outputs | Preview Accuracy | Defaults, Fallbacks & Reset |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Classroom Name** (`classroomName`, `<=80` chars) | Admin | `/plato/customizer` (`AdminStyles.jsx`) -> `PUT /v1/admin/theme` -> `_system/settings.classroomName` + `sessionStorage('plato_branding')` | Learner header, `<title>` on learner/public pages, text-initial favicon, public auth headers, invite & password-reset emails (`email.js`). Fixed `"plato"` on `/plato/*`. | Accurate in `CustomPreviewCard` (truncates smoothly). | Default/Seed/Reset: `"Plato"` (fallback `"plato"` in `BrandingContext` when empty). |
| **Classroom Logo** (`logoBase64` / `logoUrl`) | Admin | `/plato/customizer` (`AdminStyles.jsx`) -> `PUT /v1/admin/theme` -> `_system/settings.logoBase64` + `/v1/branding/logo/:hash` | Learner header (`max-w-[160px] h-7`), public auth headers (`max-w-[200px] h-8`), favicon canvas (`32x32`). Email templates intentionally omit base64 logos (`email.js`). | Accurate in `CustomPreviewCard`; email omission is not mentioned in UI hint. | Default/Reset: `null` (renders classroom name text in header and 1-letter initial in favicon). |
| **Primary Color** (`theme.primary`) | Admin | `/plato/customizer` -> `PUT /v1/admin/theme` -> `_system/settings.theme.primary` | `--classroom-header-bg`, `--primary`, `--classroom-primary-text-*`, dark-mode surface tint (`--classroom-tint-hue/chroma`), user chat bubbles, progress bars, email CTA buttons. | Preview matches classroom CSS rules (`buildThemeVars`). | Seed/Reset: `#8b1a1a` (maroon). Fallback constant `DEFAULT_PRIMARY` in `branding.js` is `#470d99`. |
| **Accent Color & Match Primary** (`theme.accent`) | Admin | `/plato/customizer` -> `PUT /v1/admin/theme` -> `_system/settings.theme.accent` (omitted when matched) | `--classroom-link-light/dark` (links in `.coach-copy`) and `--ring` / `--classroom-ring-*` (keyboard focus rings). | Preview matches classroom CSS rules. | Default/Reset: matches `primary`. |
| **Theme Mode** (`light` / `dark`) | Visitor / Learner / Admin | `ThemeToggle` in `AppShell`, `AdminLayout`, and `Login` -> `localStorage('plato_theme')` | Toggles `.dark` on `<html>` across both learner and admin shells. | Customizer previews both Light and Dark simultaneously. | Default: follows `prefers-color-scheme` until user clicks `ThemeToggle`. No UI reset to system default. |
| **Fixed Admin Identity** | Application Code | [`client/src/index.css`](file:///home/ubuntu/googleplato/client/src/index.css#L1-L138) + [`AdminLayout.jsx`](file:///home/ubuntu/googleplato/client/src/components/AdminLayout.jsx) | All `/plato/*` routes use fixed Plato purple (`oklch(0.32 0.17 296)` light / `oklch(0.73 0.15 296)` dark) and neutral surfaces. | Intentional boundary per `DESIGN.md` (except favicon bleed in **Finding 6**). | Fixed in code. |
| **Semantic Status Colors** | Application Code | [`client/src/index.css`](file:///home/ubuntu/googleplato/client/src/index.css#L75-L138) (`--success`, `--warning`, `--danger`, `--in-progress-*`, `--completed-*`) | Alerts, badges, readiness bars, lesson status icons (`StatusIndicator`). | Fixed semantic hues; unaffected by brand palette. | Fixed in code. |
| **Knowledge Base** (`content`, `conversation`, `readiness`) | Admin | `/plato/customizer/knowledge/edit` (`KnowledgeBaseEditor.jsx`) -> `PUT /v1/admin/knowledge-base` -> `_system/knowledge-base` | Admin `KBViewer` and system prompt context for AI coach turns. | Uses `renderMd()`, but `Save` re-runs AI extraction (**Finding 3**). | Default: empty (`"No knowledge base yet."`). |
| **Courses & Lessons** (`course:*`, `lesson:*`) | Admin / Content Author | `/plato/lessons`, `/plato/lessons/:id/edit` (`LessonEditor.jsx`) -> `_system/course:*`, `_system/lesson:*` | Learner `/lessons` grid, course filter dropdown, `LessonDetailDialog`, `/lessons/:lessonId` coach & outline modal. | Preview renders full Markdown via `renderMd()`, diverging from `parseLessonPrompt()` plain-text fields (**Finding 4**). | Seeded default lessons; status `draft` / `private` / `public`. |
| **Learner Profile & Custom User Fields** | Admin (schema) & Learner (values) | Schema: `/plato/users` -> `_system/settings.userFields`. Values: `/settings` & `ProfileCompletionGate` -> `users.customFields` | `/settings`, `ProfileCompletionGate`, `/plato/users` detail drawer, coach context. | Direct form controls in `/plato/users` and `/settings`. | Default: no custom fields; `name` synced via `preferences`. |
| **Plugins (`teacher-comments`, `wordpress-info`, `slack`)** | Admin & Plugin Code | `/plato/plugins` -> `_system/plugins` (`enabled`); plugin routes under `/v1/plugins/:id/*` | `AdminUserDetailSlot` in `/plato/users` (`teacher-comments`), coach enrichment (`wordpress-info`), Slack webhook notifications. | Slots inherit admin card/text tokens cleanly (`AdminUserDetail.jsx`). | Default: disabled until enabled in `/plato/plugins`. |

---

## 6. Visual & Design Opportunities and Open Product Questions (Non-Defects)

1. **Email Logo Delivery (`Product Question`)**: [`server/src/lib/email.js`](file:///home/ubuntu/googleplato/server/src/lib/email.js#L18-L62) uses `classroomName` and `theme.primary` for transactional emails, and intentionally omits `logoBase64` because Gmail/Outlook strip `data:` URIs. Now that `/v1/branding/logo/:hash` serves an immutable public HTTP URL (`${APP_URL}/v1/branding/logo/${hash}`), should transactional emails embed `<img src="${APP_URL}/v1/branding/logo/${hash}">` when `APP_URL` is publicly reachable, or should `AdminStyles` clarify that emails use the classroom name and primary color?
2. **Returning to System Theme Preference (`Design Opportunity`)**: Once a visitor clicks `ThemeToggle`, `localStorage.getItem('plato_theme')` locks them into explicit `'light'` or `'dark'` mode. Offering a 3-state control (`System` / `Light` / `Dark`) in `/settings` would let users return to automatic device-following without clearing browser storage.
3. **Client Bundle Chunking (`Engineering Polish`)**: `npm run build:client` emits a single `551.06 kB` JS bundle. Route-level `React.lazy()` splitting between `/plato/*` (admin/authoring) and learner/public routes would reduce initial learner download size.

---

## 7. What Is Working Well and Should Be Preserved

- **Side-by-Side Customizer Previews (`AdminStyles.jsx`)**: Rendering both Light and Dark preview cards simultaneously using real `<Card>` and `<Button>` components and isolated inline CSS variables gives administrators immediate visibility into both themes regardless of their active admin theme.
- **Logo Upload Pipeline & SVG Security (`logoUpload.js`, `server/src/lib/branding.js`)**: Client-side and server-side validation, `viewBox` dimension synthesis (verified in WebKit), raster downscaling (`400x120`), immutable content-addressed logo caching (`/v1/branding/logo/:hash`), and `uploadEpoch` race protection are well-engineered.
- **Admin vs. Classroom Branding Boundary (`DESIGN.md`, `AdminLayout.jsx`)**: Keeping `/plato/*` in fixed Plato neutral/purple tokens ensures that an experimental or low-contrast classroom brand never locks an administrator out of the Customizer controls.
- **Responsive Reflow & 200% Text Zoom**: Both `/plato/customizer` and `/lessons` reflow cleanly at `320px` and `390px` viewports in Chromium and WebKit, with `wrap-anywhere` and `truncate` preventing horizontal overflow under long Unicode classroom and lesson names.

---

## 8. Coverage Summary

- **Inspected & Tested Locally (`Code`, `Render`, `Device`)**:
  - Documentation & prior remediation baseline (`AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, `docs/ARCHITECTURE.md`, `docs/plugins/*`, `docs/reviews/classroom-customizer-remediation-2026-10-25.md`).
  - Full client & server unit test suites (`1,332` tests) and Playwright browser test suites (`37` browser tests across Chromium and WebKit, plus targeted audit scenarios and screenshots in `output/playwright/2026-10-26/`).
  - 7 representative brand palettes across Light and Dark modes (`#8b1a1a`, `#1d4ed8`, `#f8fafc` matched, `#f8fafc` + `#1d4ed8`, `#09090b`, `#eab308`, `#bae6fd` + `#fef08a`).
  - Customizer `Styles` and `Knowledge` workflows, `LessonEditor`, `LessonsList`, `LessonChat`, `Settings`, `ProfileCompletionGate`, `AdminUsers` + plugin slots, `AdminPlugins`, public auth routes, and `server/src/lib/email.js`.
- **Untested Boundaries**:
  - Live external email client rendering (Gmail/Outlook inbox rendering of HTML generated by `server/src/lib/email.js`; inspected at the code/HTML template level per review constraints against sending real emails).
  - Live paid LLM extraction quality (mocked/intercepted `/v1/ai/messages` per review constraints against making paid AI calls).

---

## 9. Prioritized Implementation Sequence & Proposed Regression Coverage

1. **Priority 1 — Live Branding Sync Across SPA Navigation (Fixes Finding 1)**
   - **Change**: Emit a `plato:branding-updated` event from `invalidatePublicBranding()` and subscribe in `BrandingProvider` so saving in `/plato/customizer` immediately updates `BrandingContext` state.
   - **Regression Test**: Add a Playwright test in `client/test/browser/customizer.browser.test.js` that navigates `/lessons` -> `Admin Dashboard` -> `Customizer` -> saves a new name and color -> uses `page.goBack()` to return to `/lessons` and asserts the new header color and `document.title` without reloading.
2. **Priority 2 — Light-Mode Action Fill & Progress Contrast Floor (Fixes Finding 2)**
   - **Change**: Add `lightFillColor(primary)` in `client/src/lib/branding.js` (or apply a contrasting border when `contrastRatio(primary, '#f5f5f5') < 3`) and update `DARK_CARD` reference luminance so primary buttons, user chat bubbles, and progress fills maintain `>= 3.0:1` contrast in both light and dark modes.
   - **Regression Test**: Add a unit test in `client/test/branding.test.js` asserting `>= 3.0:1` fill-to-surface contrast and `>= 4.5:1` text-to-fill contrast across all 7 representative brand palettes in both light and dark modes.
3. **Priority 3 — `KnowledgeBaseEditor` Save Parity, Status Banner & Unsaved Blocker (Fixes Finding 3)**
   - **Change**: Save `previewMarkdown` directly when `!previewStale` in `KnowledgeBaseEditor.jsx`, pass `saved` to `MarkdownPreviewPane`, add `useBlocker`/`beforeunload` protection, and fallback `initialReadiness` to `8` when `kb.content` exists.
   - **Regression Test**: Add component/browser tests verifying that saving after `Refresh preview` performs zero additional extraction calls and that switching tabs with unsaved KB chat turns triggers the confirmation dialog.
4. **Priority 4 — Markdown Parser Completeness & Authoring-to-Learner Parity (Fixes Finding 4)**
   - **Change**: Add fenced code block, inline code, and blockquote rules to `renderMd()` in `client/src/lib/helpers.js`; support `## Description` and multi-line descriptions in `parseLessonPrompt()`; and format/strip inline Markdown in `LessonCard`, `LessonDetailDialog`, and `LessonChat` outline dialogs.
   - **Regression Test**: Add unit tests in `client/test/helpers.test.js` and `server/test/lessonMarkdown.test.js` for `<pre><code>`, `<code>`, `<blockquote>`, and `## Description` multi-paragraph parsing.
5. **Priority 5 — `Match primary` Uncheck Sync, `PUT /v1/admin/theme` Validation, Favicon Scoping & Public Page Polish (Fixes Findings 5, 6, 7, 8)**
   - **Change**: Preserve the current primary color in `draft.accent` when unchecking `Match primary`; reject `{ theme: {} }` missing `primary` in `PUT /v1/admin/theme`; update all `link[rel='icon']` tags and restore default favicons on `/plato/*`; add logo contrast guidance/backdrop option; and add `<ThemeToggle />` to all public pages.
   - **Regression Test**: Add unit and browser assertions in `server/test/admin-theme.test.js` and `client/test/browser/customizer.browser.test.js`.
