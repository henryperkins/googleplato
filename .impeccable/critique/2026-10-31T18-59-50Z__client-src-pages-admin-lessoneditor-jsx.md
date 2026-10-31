---
target: "Photos 1-3: lesson list and lesson review/publishing"
total_score: 28
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 1
target_identity: "file:/home/ubuntu/googleplato/client/src/pages/admin/LessonEditor.jsx"
target_fingerprint: "sha256:e1ecbf4643a55c526e2a7b7d7918da6b4e8402f251e448cffdcf10f875ff65f6"
target_path: /home/ubuntu/googleplato/client/src/pages/admin/LessonEditor.jsx
timestamp: 2026-10-31T18-59-50Z
slug: client-src-pages-admin-lessoneditor-jsx
closed: true
---
Method: dual-agent (A: /root/critique_design_a · B: /root/critique_evidence_b)

**Verdict: the visual language fits Plato; the mobile review-to-save sequence needs another pass.** The purple admin shell, restrained controls, serif assistant voice and exemplar/objective preview form a coherent learning workspace. A brand redesign would add little here. The biggest opportunity is to put the finishing choices beside the content the author has just reviewed.

This is a read-only critique of Photos 1–3, checked against current source and fresh local Chromium renders at 320px and 1280px in light and dark themes. Scores are heuristic judgments of these sampled states. Error-recovery protections were inspected in source; failure recovery and physical-device behavior were not requalified in this critique.

## What works

- **Visibility is an explicit decision.** Save privately has primary emphasis, while Save & make public names the wider action and explains its classroom audience. Keep that private default.
- **The preview exposes the learning contract.** Exemplar and objectives are easy to distinguish, and conversation and output have separate regions.
- **The visual fundamentals hold.** Sampled mobile publishing buttons are 44px high, and measured enabled button/help text contrast passes the relevant text threshold in both themes. The dark palette is legible. These samples do not certify every state or accessibility requirement.

## Priority issues

### 1. [P1] Mobile review ends away from its finishing actions

**Evidence: Photo 3; Render + Code.** The narrow action region is 210px high and precedes the conversation and preview. At the end of the photographed short preview, Save privately is above the visible main region while Save & make public remains visible near the top. In a supplementary long preview, both finishing actions are offscreen. The narrow toolbar is deliberately static; this is backtracking and unequal choice availability, rather than a permanent overlay collision.

**Why it matters:** The author must leave their reading position to recover the preferred private action at the moment of commitment. Private and public should be equally available after review.

**Fix:** On phones, place both finishing choices immediately after the preview in normal flow. Keep private emphasized and the public audience explicit. Move Start over out of that finishing cluster. A separate Edit/Review view is another possible approach if longer conversations need it. Suggested command: `/impeccable adapt`.

Evidence: [narrow review end](../../output/playwright/lesson-publishing-critique/a/editor-320-dark-review-end.png). Source: `LessonEditor.jsx:370` and `client/src/index.css:465`.

### 2. [P2] The phone lesson list retains desktop-table interaction

**Evidence: Photo 1; Render + Code.** The table is 638px wide inside a 288px scroll region, requiring 350px horizontal travel to reach its far end. Name and visibility remain pinned and usable, but secondary metrics and edit/delete lie to the right; Updated is partly obscured at the far end. The page itself does not overflow.

**Why it matters:** Occasional admins must discover an unlabelled horizontal gesture for routine management. Search and two full-width filters also take substantial space before the first lesson.

**Fix:** Preserve the dense desktop table. On phones, use a compact row with title, visibility, course and a named actions menu, with metrics in expandable detail. Keep search visible and group the optional filters behind a Filters control. Suggested command: `/impeccable adapt`.

Evidence: [right-scrolled list](../../output/playwright/lesson-publishing-critique/a/list-320-light-right.png). Source: `AdminLessons.jsx:383`, `:425`, and the table primitive.

### 3. [P2] Readiness looks authoritative without a stable explanation

**Evidence: Photos 2 and 3; Render + Code.** The green 8/10 meter sits beside publishing choices without explaining the score or what remains. It estimates development of the lesson in conversation; generated-preview validation is separate. The short synthetic conversation cannot establish what a real assistant normally explains.

**Why it matters:** An author may interpret it as content quality, approval, or a publication requirement, each implying a different next step.

**Fix:** Give readiness a concise definition and contextual rubric, identify missing requirements when known, and explain that the author must review the exemplar and objectives before saving. Preserve the existing thresholds and validations. Suggested command: `/impeccable clarify`.

Source: `LessonEditor.jsx:371` and `client/prompts/lesson-creator.md:114`.

### 4. [P2] Mobile navigation removes the labels people need to learn

**Evidence: Photos 1 and 3; Render + Code.** Six destinations become icons below 480px. Palette, sparkles and puzzle require learning their mapping to Customizer, AI Settings and Plugins. Each destination has a screen-reader name and a 52×44px target; this is a visible-recognition concern, not an unnamed-control finding. The treatment is an existing documented shell convention.

**Why it matters:** Unfamiliar sighted admins lose the desktop interface's vocabulary at the narrow breakpoint.

**Fix:** Keep visible labels for frequent destinations and group occasional settings under a labelled More destination, or use a clear two-row labelled layout. Select permanent destinations from actual admin tasks. Suggested command: `/impeccable clarify`.

Source: `AdminLayout.jsx:241`.

## Design health

| Heuristic | Score / 4 | Assessment |
| --- | --- | --- |
| System status | 3 | Draft, saving scope and preview state are visible. |
| Match with the real world | 3 | Action labels are clear; readiness needs definition. |
| User control | 3 | Back, Cancel, Escape and confirmed restart support control. |
| Consistency | 3 | Cohesive components; mobile hides navigation vocabulary. |
| Error prevention | 3 | Private default, preview validation and guarded reset. |
| Recognition over recall | 3 | Clear save actions; mobile navigation/review adds recall. |
| Efficiency | 2 | Filters help; narrow management and finishing require travel. |
| Aesthetic restraint | 3 | Calm composition; mobile metadata/actions delay the preview. |
| Error recovery | 3 | Code-backed retry, preserved work and conflict controls. |
| Contextual help | 2 | Useful inline guidance; no stable readiness explanation. |
| **Total** | **28/40 — Good** | **Address mobile finishing first.** |

**Cognitive load: moderate on narrow review.** Three of eight checklist items fail: hierarchy, one decision at a time, and working memory across the review/save positions. The finishing decision has two outcomes plus one secondary restart, so the number of buttons alone is not the problem. Six navigation destinations and six data columns are not automatically overload; hidden labels and horizontal discovery are the stronger evidence.

**Emotional journey:** automatic conversation saving and the structured preview build confidence. That confidence dips at the mobile finishing step when the private choice needs to be recovered above the reading position. The interface should finish with the same clarity it provides at the start.

## Persona checks

- **Alex, frequent admin:** horizontal travel for management actions and an upward return after review slow the task. Inventory scale was not established, so bulk operations are not a requirement from these images.
- **Sam, accessibility-dependent admin:** accessible navigation names and tested native-dialog Escape/focus restoration are strengths. Visual labels disappear on phones; reading and commit order still need care. No screen-reader session or complete keyboard publication flow was qualified in this critique.
- **Casey, interrupted mobile author:** the preview begins low in the initial viewport, and the preferred private action can be out of view after reading. Physical keyboards, browser chrome, gestures and interruptions were not exercised.

The confirmed product context leaves the admin operator's audience open; these are generic task personas, not invented staff or organizational roles.

## Smaller observations

- Private (1) needs a unit: Private · 1 person, or Only you when the selected user is the author. The count's meaning is not explicit in Photo 1.
- The ordinary review instruction uses warning colors. A neutral note could reserve amber for stale previews and uncertain saves.
- Code-only: the creator prompt still refers to Create Lesson, while current controls use Generate preview, Save privately and Save & make public. No live model output was sampled.

## Detector and run notes

The narrowed static scan returned **0 findings**. Runtime injection succeeded in three headless browser views. The live detector flagged one rule, nested-cards, in two editor views; it highlighted the functional composer boundary inside the conversation surface. That is a contextual false positive for this task and does not justify removing the input boundary. No user-visible live overlay is available.

All owned app and overlay services were stopped, browsers closed, and temporary databases removed. Existing services and application work were preserved; the tracked application diff hash is unchanged. Only critique evidence and archive files were written. Physical-device, assistive-technology and live-production behavior remain unverified.

Full independent assessments and raw browser measurements are in `output/playwright/lesson-publishing-critique/a/` and `b/`. The app source was not modified.
