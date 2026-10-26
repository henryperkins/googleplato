---
target: "https://plato-shaped.ai.studio/plato/users"
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
target_identity: "file:/home/ext_allthesecrushes_gmail_com/googleplato/client/src/pages/admin/AdminUsers.jsx"
target_fingerprint: "sha256:41564d0ea536e5e5a4963df38ffd198e94448a693d15234c81630674f5e330de"
target_path: /home/ext_allthesecrushes_gmail_com/googleplato/client/src/pages/admin/AdminUsers.jsx
timestamp: 2026-10-26T08-38-43Z
slug: client-src-pages-admin-adminusers-jsx
closed: true
---
Method: dual-agent (A: /root/design_review · B: /root/detector_evidence)

Reviewed https://plato-shaped.ai.studio/plato/users as an operational admin surface. Production requires sign-in, so the visual and interaction assessment used the matching rebuilt client with synthetic data and intercepted API requests. The checkout commit and rebuilt asset match production. Inspected desktop, 390px and 320px mobile, dark mode, editing, filtering, and invitation failure. No production records were changed or invitations sent.

**The visual foundation is solid; task feedback needs the most attention.** Plato's purple navigation, restrained typography, and familiar table feel coherent. Conventional administration patterns fit this surface. Learning progress provides product specificity, but its meaning needs clearer explanation. Preserve the current visual identity and concentrate on dependable actions and mobile scanning.

Three strengths stand out:

- **Clear action hierarchy:** Invite Users leads; less frequent configuration lives under Manage.
- **Readable desktop directory:** identity, membership, and activity align cleanly, with useful whitespace and a coherent dark theme.
- **Considered accessibility foundations:** named row actions, native table semantics, sortable-header announcements, confirmation dialogs, and a keyboard-scrollable table with pinned identity.

**Design health: 25/40 — acceptable, with focused improvements needed.** Scores use Nielsen's ten heuristics, each out of four; this is a design judgment, not a conformance certification.

| Heuristic | Score | Main observation |
|---|---:|---|
| System status | 2/4 | Save has no pending feedback |
| Match with real world | 3/4 | Familiar language; role and status overlap |
| User control and freedom | 3/4 | Back, Cancel, drafts, and confirmations exist |
| Consistency and standards | 3/4 | Account saving differs from waitlist saving |
| Error prevention | 2/4 | Repeated Save clicks create overlapping requests |
| Recognition over recall | 3/4 | Mobile hides actions beyond the initial table view |
| Flexibility and efficiency | 2/4 | Good search/sorting; limited batch management |
| Aesthetic and minimalist design | 3/4 | Clean layout; repeated progress rings dominate |
| Error recovery | 2/4 | Hidden invite error and misleading empty state |
| Help and documentation | 2/4 | Invitation guidance exists; progress basis is unclear |
| **Total** | **25/40** | **Acceptable** |

The five priorities, in order:

1. **P1 — Invitation errors appear behind the dialog.** A simulated failed send left the dialog open while the error appeared behind its blurred backdrop. Keyboard focus also fell to the document. Admins cannot readily understand what happened. Put the error beside Send, preserve the queued addresses, and keep the busy button focusable so retry is straightforward. **Command:** `/impeccable harden`. Evidence: `AdminUsers.jsx:288`, `:930`, `:1264`; `.impeccable/review/users-2026-10-26/invite-error.png`.

2. **P1 — Save gives no pending feedback and accepts repeat submissions.** Two clicks during a delayed request produced two PATCH requests; fields stayed editable. Add a visible Saving state, block repeat activation while preserving focus, make fields read-only during the request, and confirm the result. **Command:** `/impeccable harden`. Evidence: `AdminUsers.jsx:654`, `:872`; Assessment A intercepted-request verification.

3. **P1 — Custom-field filtering can falsely report an empty directory.** With six records loaded, Team → Operations displayed “No users yet. Click ‘Invite Users’ to get started.” This suggests missing records and sends the administrator toward the wrong action. Show “No users match these filters,” a result count, and Clear filters. **Command:** `/impeccable clarify`, including the empty-state condition fix. Evidence: `AdminUsers.jsx:1177`; `.impeccable/review/users-2026-10-26/filtered-empty.png`.

4. **P2 — Mobile hides useful information and actions across a wide table.** At 390px, the table starts roughly 394px down the screen and requires horizontal scrolling to reach progress, activity, and row actions. The page itself does not overflow; pinned identity works. Use a compact mobile row with identity, status, and a relevant action, then disclose secondary details. **Command:** `/impeccable adapt`. Evidence: `AdminUsers.jsx:970`, `:1030`; `.impeccable/review/users-2026-10-26/mobile.png`.

5. **P2 — Completion rings imply judgment without explaining the target.** A new learner receives a red 0%, while the compact ring hides the visible numerator and denominator. For self-directed learning, this can suggest poor performance simply because available lessons remain unfinished. Show “3 of 10 available lessons completed,” clarify the basis, and reserve warning colors for a defined intervention condition. Confirm the intended metric before changing it. **Command:** `/impeccable clarify`. Evidence: `CompletionRing.jsx:15`, `:27`, `:73`; `AdminUsers.jsx:1123`.

**Cognitive load is moderate on mobile:** working-memory support and progressive disclosure are weak because identity, activity, and actions must be read across horizontal scroll positions. Five filters and six sortable headers exceed four visible options, but their useful grouping means the count alone is not a defect. Emotionally, the calm entry and invitation queue build confidence; ambiguous saving, hidden errors, and a false empty directory undermine it at the moment of action.

Persona checks reinforce the priorities:

- **Alex, a frequent administrator:** repeated Save clicks are accepted; routine waitlist work remains one record at a time.
- **Sam, a keyboard/screen-reader user:** invite failure loses focus; opening an editor also removes the focused row button without placing focus on the new heading. No keyboard trap was observed.
- **Casey, a mobile administrator:** Invite/Remove and progress sit outside the initial table view; six bottom-navigation icons require recognition without visible labels below 480px, although accessible names exist.

Smaller refinements: use Learner consistently instead of alternating with User; separate account role from Invited/Wait List status; use Never instead of an unexplained dash for no activity. A group filter would support cohort work if it is common.

**The automated scan reported zero findings** across AdminUsers and nine related components, plus settled desktop, mobile, dark-mode, and invite-error browser scans. The manual checks exposed the behavioral issues above. Transient warnings during an artificial theme transition were excluded after a settled scan through the actual theme control. Injection succeeded in a headless browser; no user-visible overlay is available. All temporary preview and detector servers were stopped. No application source was changed.

Questions for the next pass:

1. Which should lead: reliable save/invite/filter feedback, mobile usability, or clearer progress meaning?
2. Should the next pass address the three P1 issues, or all five priorities?
