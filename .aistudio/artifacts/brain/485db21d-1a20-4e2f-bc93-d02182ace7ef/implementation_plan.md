# Mobile Web UX Audit & Fix Plan — High-Traffic Journeys

Conduct a rigorous Mobile Web UX Audit and targeted fix pass across **plato**'s highest-traffic routes—**Learner Classroom & Lesson Chat** (`/lessons`, `/lessons/:lessonGroupId`) and **Authentication & Onboarding** (`/login`, `/signup`, `/setup`, `/waitlist`, `/forgot-password`, `/reset-password`)—governed by the **October 19, 2026 Mobile Web UX Audit Contract**.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following audit parameters reflect your confirmed selections from Phase 1:

- **Confirmed Scope — High-Traffic Route Groups**:
  1. **Learner Classroom & Lesson Chat** (`/lessons`, `/lessons/:lessonGroupId`, `AppShell`, `ComposeBar`, `ChatArea`, `LessonDetailDialog`).
  2. **Authentication & Onboarding** (`/login`, `/signup`, `/setup`, `/waitlist`, plus `/forgot-password` and `/reset-password`).
- **Confirmed Execution Mode — Audit and Fix (Apply Safe Fixes, Propose Device-Dependent Diffs)**:
  - **Safe fixes** (touch target hit areas, image dimensions/aspect ratios, form attributes like `autocomplete`/`enterkeyhint`/`autocapitalize`, safe-area padding on auth screens, draft survival in `sessionStorage`, and button loading states) will be **applied directly** and verified via automated tests and compilation.
  - **Device-dependent fixes** (changes to `visualViewport` keyboard offset math, iOS Safari scroll-lock physics, `touch-action` gesture overrides, or `interactive-widget` behavior whose regressions only appear on real mobile OS toolbars/keyboards) will be **proposed as minimal diffs** alongside a prioritized **10-entry Device Check Script** for human verification.
- **Confirmed Support Matrix & Display Modes**:
  - **Browsers**: iOS Safari 17+ (including iOS 26 Compact/Bottom/Top tab bars) and Chrome Android current (including Chrome 135+ edge-to-edge gesture navigation chin).
  - **Display Modes**: Mobile Browser Tab and Installed PWA (`display-mode: standalone`).
- **Verification Ceiling**:
  - `Ceiling: mechanism (static code review + automated node:test suite); no live iOS Simulator, Android Emulator, or physical device attached to the agent runtime.` All checks disclose mocked/stubbed dependencies per the October 19, 2026 evidence rules.

---

## 1. Overview & Core Concept

- **What It Does**: Audits the principal mobile user journeys end-to-end across 320px, 360px, 390px, 430px, and short landscape (`max-height: 500px`) viewports; applies surgical, low-risk fixes for defects found in source; and delivers a structured Master Audit Report + Deep-Dive Findings (Modules 2–7) with a 10-check human device script.
- **Target Audience / Persona**: Mobile learners completing AI-coached lessons on phones in one-handed or two-thumb grips, and new learners/administrators onboarding via mobile invite links or Google Sign-In.
- **Key Value**: Eliminates mobile tap misses, layout shifts, unannounced form errors, notch/home-indicator clipping on full-bleed auth pages, and lost form inputs during mobile tab discards—without risking blind regressions on device-specific keyboard or scroll physics.

---

## 2. User Experience & Visual Design

- **Key User Flows Audited & Enhanced**:
  1. **Principal Journey — Completing an AI-Coached Lesson (`/lessons` → `/lessons/:id`)**:
     - Filtering courses/statuses on `/lessons`, scanning lesson cards, opening the **View outline** bottom sheet, entering a lesson chat, reading streamed coach responses, attaching images/links in `ComposeBar`, and advancing to the next lesson.
  2. **Secondary High-Traffic Journey — Mobile Onboarding & Sign-In (`/login`, `/signup`, `/setup`, `/waitlist`)**:
     - Signing in with password or Google popup/redirect, completing multi-field invite signups with custom user fields, recovering passwords, and surviving background tab discards when switching apps to copy an invite link or verification details.
- **Visual Identity & Theme Preservation**:
  - *Aesthetic Direction*: Retains **plato**'s clean, focused microlearning interface and dynamic classroom branding (`--primary`, `--primary-text`, `--ring`).
  - *Color Palette & Mood*: Preserves existing semantic tokens (`bg-background`, `bg-card`, `text-foreground`, `border-border`) and dynamic WCAG-checked classroom header themes.
  - *Typography & Hierarchy*: Maintains `max(16px, 1rem)` minimum font size on all mobile form controls to prevent iOS Safari focus auto-zoom while preserving pinch-to-zoom (`user-scalable` never restricted) and `clamp()` / `rem` scaling.
  - *Touch Target & Spatial Discipline*: Ensures every interactive control meets WCAG 2.2 AA (24×24 CSS px minimum) and reaches the 44×44px ergonomic target on coarse pointers via non-overlapping hit areas, while keeping sticky bars under the 15% mobile viewport height cap.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Enforcing Non-Overlapping Hit Areas on Attachment Removal Chips (`ComposeBar`)**
  - *Chosen Approach*: Expand the tap hit area of `.compose-chip-remove` buttons (currently 28×28px visual size) using an invisible `::after` pseudo-element (`inset: -8px`) so the effective touch target reaches 44×44px without enlarging the visual badge over the thumbnail or link text, and add spacing (`gap-3`) between image thumbnails so enlarged hit areas never overlap.
  - *Why*: Meets Apple HIG (44×44px) and WCAG 2.5.8 target spacing rules without cluttering compact mobile attachment previews.
- **Decision 2: Safe-Area Inset & Landscape Protection on Full-Bleed Auth Pages**
  - *Chosen Approach*: Add explicit safe-area padding (`pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]`) and explicit `width`/`height` attributes on classroom logos across `/login`, `/signup`, `/setup`, `/waitlist`, `/forgot-password`, and `/reset-password`.
  - *Why*: Because `viewport-fit=cover` is enabled globally in `index.html`, standalone PWAs and landscape phones otherwise allow full-bleed auth headers/footers to collide with the iOS status bar, Dynamic Island, or home indicator, and un-dimensioned logos cause layout shift (CLS) when loading.
- **Decision 3: Form Ergonomics, Keyboard Advance, and Input Survival Across Auth & Classroom**
  - *Chosen Approach*:
    - Add `sessionStorage` draft persistence to `Login` (username/email only) and `ForgotPassword` (email) matching `Signup`, `Setup`, `Waitlist`, and `LessonChat`.
    - Fix `Waitlist` email field `onKeyDown` Enter handler so pressing "Next" advances focus to the first custom field or group select rather than doing nothing, and wire `submitting` state + double-submit prevention to `ForgotPassword` and `ResetPassword`.
    - Add explicit `width`/`height` dimensions to brand logos and chat image previews (`decoding="async"`) to prevent layout shifts during image decode.
- **Decision 4: Proposing (Not Applying) Device-Dependent VisualViewport & iOS Scroll-Lock Diffs**
  - *Chosen Approach*: Document the exact minimal diffs for iOS 26 Safari toolbar tinting / `visualViewport` offset edge cases and Chrome 135+ Android `safe-area-max-inset-bottom` in the audit report, and schedule their verification in the 10-entry human Device Check Script.
  - *Why*: Honours your Phase 1 instruction (`apply safe fixes and propose device-dependent diffs`) and the October 19, 2026 Audit Contract rule that fixes whose regressions only surface on physical OS toolbars/keyboards must not be applied blindly.

---

## 4. Technical Architecture & Audit Execution Strategy *(Technical Reference)*

- **High-Traffic Route & Audit Module Mapping**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                Mobile Web UX Audit & Fix Pipeline (Oct 19)                 │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
        ┌─────────────────────────────┴─────────────────────────────┐
        ▼                                                           ▼
┌───────────────────────────────────────┐   ┌────────────────────────────────┐
│   Principal Journey 1: Classroom      │   │ Principal Journey 2: Auth      │
│   • AppShell (Header / Admin Bar)     │   │ • Login / Signup / Setup       │
│   • LessonsList (Filters / Cards)     │   │ • Waitlist / Forgot / Reset    │
│   • LessonDetailDialog (Bottom Sheet) │   │ • Safe-area & CLS protection   │
│   • LessonChat & ComposeBar           │   │ • Keyboard hints & Drafts      │
└───────────────────┬───────────────────┘   └───────────────┬────────────────┘
                    │                                       │
                    └───────────────────┬───────────────────┘
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     Verification & Deliverables Layer                      │
│  1. Applied Safe Fixes (DOM/CSS/Attributes/Drafts/CLS/Touch Hitboxes)      │
│  2. Automated Regression Tests (node:test suite in client/tests/)          │
│  3. Master Audit Report (Verdict, Coverage Table, Findings, Field Table)   │
│  4. Prioritized 10-Entry Device Check Script (C-01..C-10) for Human Run    │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Safe Fixes to Apply & Verify in Code**:
  1. **Touch Hitbox & Spacing (`index.css`, `ComposeBar.jsx`, `PasswordField.jsx`)**:
     - Expand `.compose-chip-remove` touch target via `::after` (`inset: -8px`) and increase attachment chip container gap so adjacent remove buttons never overlap.
     - Ensure `PasswordField` toggle button (`Show`/`Hide`) maintains a clean 44×44px hit area vertically centered inside the input without clipping the input focus ring.
     - Add `:active` feedback (`active:scale-[0.98]` / background tint) and `touch-action: manipulation` on rapid-tap pagination and compose controls while preserving `prefers-reduced-motion`.
  2. **Viewport, Safe Areas & Layout Shift (`Login.jsx`, `Signup.jsx`, `Setup.jsx`, `Waitlist.jsx`, `ForgotPassword.jsx`, `ResetPassword.jsx`, `AppShell.jsx`, `LessonChat.jsx`)**:
     - Apply safe-area top/bottom/left/right inset clearance on all standalone auth `<main>` containers so `viewport-fit=cover` never clips content under the notch or home indicator in portrait, landscape, or installed PWA mode.
     - Add explicit `width` and `height` attributes (and `decoding="async"`) to auth logos, header logos, and user-uploaded chat images to eliminate layout shift (CLS).
     - Set `background-color` and `color-scheme: light dark` on `html` in `index.css` to prevent white navigation flashes on dark-mode mobile browsers.
  3. **Form Ergonomics, Keyboard Hints & Recovery (`Waitlist.jsx`, `Login.jsx`, `ForgotPassword.jsx`, `ResetPassword.jsx`, `ComposeBar.jsx`)**:
     - Persist non-sensitive email/username drafts in `sessionStorage` on `Login` and `ForgotPassword` so background tab discards never lose typed input.
     - Add `submitting` state and disabled button feedback to `ForgotPassword` and `ResetPassword` to prevent duplicate POST submissions on slow mobile networks.
     - Wire Enter-key focus progression (`onKeyDown`) on `Waitlist` email input to advance to the next visible field or submit cleanly.
  4. **Automated Regression Tests & Structured Audit Report**:
     - Add mobile UX regression tests in `client/tests/` verifying safe-area classes, touch target rules, form attributes (`inputMode`, `enterKeyHint`, `autoComplete`), draft persistence, and dependency-disclosure compliance.
     - Deliver the complete October 19, 2026 Audit Report (Verdict, Coverage Table, Findings with Dependency Disclosures, Form Field Table, State Recovery Table, and the 10-entry Device Check Script).
