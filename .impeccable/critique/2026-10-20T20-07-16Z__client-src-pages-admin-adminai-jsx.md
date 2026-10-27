---
target: AI settings (Bedrock and Cloudflare)
total_score: 28
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
target_identity: "file:/home/ubuntu/googleplato/client/src/pages/admin/AdminAI.jsx"
target_fingerprint: "sha256:63a0f544a3bafbd058ae688a95fece5d94d7fb4a65b5a9a8403acba7530305aa"
target_path: /home/ubuntu/googleplato/client/src/pages/admin/AdminAI.jsx
timestamp: 2026-10-20T20-07-16Z
slug: client-src-pages-admin-adminai-jsx
closed: true
---

**Closeout 2026-10-27:** This is the closed critique of the local AI Settings screen captured on October 20. AI Settings refinements were subsequently integrated in commit `32f5748`. The 28/40 score and source line references describe the assessed local file; links marked “current file” are navigation aids. See the [later AI Settings review](../../docs/reviews/admin-ai-settings-2026-10-25/README.md) for the implemented follow-up.

**Evidence archive:** Historical raw captures, logs, and run records are retained privately in archive `googleplato-untracked-curation-20261027T055535Z` (`evidence-1730.tar.gz`). Paths beginning `output/` or `.mobile-ux/` below identify archive members.

Method: dual-agent (A: /root/critique_ai_design · B: /root/critique_ai_evidence)

**28/40 — Good. Four P2 priority issues; no P0 or P1 findings.**

The screen fits plato's compact administration language: restrained cards, native controls, readable typography, and clear provider choices. Familiar settings patterns suit this task. The biggest opportunity is making the active configuration, pending changes, and tested configuration explicit.

**Bedrock** is concise and exposes its fixed model and AWS region clearly. **Cloudflare** offers useful model and credential guidance, but its longer flow makes state clarity and visible feedback more important.

| Heuristic | Score | Main consideration |
|---|---:|---|
| System status | 3/4 | Active provider is clear; active model and phone results are less visible. |
| Familiar language | 3/4 | Clear purpose; setup assumes infrastructure knowledge. |
| User control | 2/4 | Reload discards the draft without saying so. |
| Consistency | 3/4 | Shared controls; missing credentials recommend a disabled action. |
| Error prevention | 3/4 | Model constraints, credential gating, and version checks help. |
| Recognition over recall | 2/4 | Saved model and hidden draft changes require remembering. |
| Efficiency | 3/4 | Short workflow and native keyboard navigation. |
| Aesthetic restraint | 3/4 | Calm presentation; repeated information adds phone height. |
| Error recovery | 3/4 | Actionable messages preserve selections; results can arrive offscreen. |
| Help and documentation | 3/4 | Useful Cloudflare guidance; thinner Bedrock setup help. |
| **Total** | **28/40** | **Good** |

Three things work well:

- Provider radios and the model select have labels, visible keyboard focus, and predictable native interactions.
- Testing is explicitly separate from activation, with a usage-charge disclosure. A successful test leaves the active provider unchanged until Save.
- Credentials stay on the server. Missing configuration blocks Test/Save, while errors and failed reloads preserve selections.

The priority issues are:

1. **[P2] Active and draft models are hard to distinguish.** With DeepSeek active and Mistral selected, the summary names only Cloudflare. Returning to Bedrock can also leave Save enabled solely for a hidden Cloudflare model edit. Admins cannot inspect exactly what is running or what Save will change. **Fix:** show the saved provider/model, summarize pending changes, and name the configuration in test/save feedback. **Command:** `/impeccable clarify`. **Code + Render:** model-only draft (archive member `output/playwright/ai-settings-critique-2026-10-20/assessment-a/12-desktop-model-only-draft.png`), hidden edit under Bedrock (archive member `output/playwright/ai-settings-critique-2026-10-20/assessment-b/bedrock-hidden-model-draft.png`); `client/src/pages/admin/AdminAI.jsx:109` (assessed source; [current file](../../client/src/pages/admin/AdminAI.jsx)).

2. **[P2] Phone test results can arrive almost entirely offscreen.** In the 390 × 844 Cloudflare case, only about 8px of the error was initially visible below the action row. Scrolling reveals it; the result is not permanently inaccessible. A sighted admin can miss completion and repeat a potentially chargeable test. **Fix:** reserve a result area above/adjacent to the actions and reveal completed feedback without moving keyboard focus. **Command:** `/impeccable harden`. **Render:** initial result (archive member `output/playwright/ai-settings-critique-2026-10-20/assessment-a/06-phone-test-error.png`), after scrolling (archive member `output/playwright/ai-settings-critique-2026-10-20/assessment-a/07-phone-test-error-scrolled.png`).

3. **[P2] Reload silently discards pending changes.** Reload replaces the selected model with the saved model and clears the unsaved marker. Its label does not disclose that effect, including during conflict recovery. **Fix:** use “Discard changes and reload” when dirty and announce completion. Keep preserving selections if reload fails; no extra confirmation modal is needed for this small form. **Command:** `/impeccable clarify`. **Code + Render:** recorded recovery sequence (archive member `output/playwright/ai-settings-critique-2026-10-20/assessment-b/save-conflict-and-reload.txt`); `client/src/pages/admin/AdminAI.jsx:37` (assessed source; [current file](../../client/src/pages/admin/AdminAI.jsx)).

4. **[P2] Missing credentials recommend an unavailable action.** The Cloudflare box says “Use Test connection” while that button is disabled. Setup instructions also omit the return step after restarting the server. **Fix:** show the sequence **Configure credentials → restart server → Reload settings → Test connection**, and associate disabled actions with their blocker. **Command:** `/impeccable onboard`. **Code + Render:** missing-credential state (archive member `output/playwright/ai-settings-critique-2026-10-20/assessment-a/09-desktop-missing-credentials.png`); `client/src/pages/admin/AdminAI.jsx:157` (assessed source; [current file](../../client/src/pages/admin/AdminAI.jsx)).

The form's cognitive load is low: two providers, two models, three actions. Active-model recall is the substantive checklist weakness. The shell's six destinations exceed the reference's choice-count guideline, but that alone does not justify hiding navigation. Emotionally, entry is calm; Cloudflare setup introduces uncertainty, and useful test/save reassurance loses impact when its result is outside the visible area.

Persona checks:

- **Alex, experienced operator:** keyboard selection is efficient; hidden model edits and ambiguous reload effects weaken confidence.
- **Sam, accessibility-focused user:** labels, focus retention, and live-region roles are positive. Disabled controls need an associated explanation; actual screen-reader announcements remain untested.
- **Jordan, first-time admin:** server setup needs an explicit handoff and return path. Model capabilities do not yet explain which option best fits the learning task.

Smaller improvements: add a corresponding Bedrock setup/access guide, reduce repeated provider wording on phones, and keep raw model IDs secondary. Model-selection advice should use verified criteria rather than invented speed, cost, or quality claims. A useful next-pass test is whether an admin can identify the active and proposed configurations at a glance.

**Evidence:** one source scan and three injected browser scans reported zero deterministic findings. Manual review identified the four usability gaps above; both assessments independently corroborated issues 1, 3, and 4. Browser visualization ran in headless Chromium, with no persistent user-visible overlay. Desktop and phone evidence used the current local production build with intercepted settings requests. No real AI calls, provider-setting writes, or application source changes were made. Physical devices and assistive technology were not qualified. Both assessment browsers and the temporary servers were stopped.
