---
target: admin shell (AdminLayout.jsx)
total_score: 23
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
target_identity: "file:/home/ubuntu/googleplato/client/src/pages/admin/AdminLayout.jsx"
target_fingerprint: "sha256:a3f95b58001e6d066315bc21e77e6c63d3284c8a933a563f2f96c2db326804f1"
target_path: /home/ubuntu/googleplato/client/src/pages/admin/AdminLayout.jsx
timestamp: 2026-10-25T05-19-58Z
slug: client-src-pages-admin-adminlayout-jsx
closed: true
---

**Closeout 2026-10-27:** The admin-shell follow-up was integrated through merge `d8a4718` (PR #21). This critique is retained as a closed historical baseline; its 23/40 score and findings describe [source revision 8744063](https://github.com/henryperkins/googleplato/blob/8744063f19c8742242a59b584db73614ddff980a/client/src/pages/admin/AdminLayout.jsx). The recorded physical-device and assistive-technology gaps remain qualification limits.

**Evidence archive:** Historical raw captures, logs, and run records are retained privately in archive `googleplato-untracked-curation-20261027T055535Z` (`evidence-1730.tar.gz`). Paths beginning `output/` or `.mobile-ux/` below identify archive members.

Method: dual-agent (A: design-review sub-agent on Sonnet · B: detector sub-agent on Sonnet)

# Critique: admin shell (`client/src/pages/admin/AdminLayout.jsx`)

Assessed revision: PR #21 (`fix/admin-mobile-nav`, 8744063), served locally and inspected in headless Chromium. Line numbers refer to that branch.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | You can always tell where you are: active highlight, `aria-current`, per-route titles. But the frame shows no system state, and route changes aren't announced. |
| 2 | Match System / Real World | 3 | Labels are plain, but names drift: Home / Dashboard / Admin Dashboard, and Classroom / Visit Classroom. The hamburger opens no menu. |
| 3 | User Control and Freedom | 3 | The drawer's exits are exemplary. Coming back from the classroom lands on Home, though, and the error screen's only exit leads to the classroom. |
| 4 | Consistency and Standards | 2 | Three different nav patterns across screen sizes. Admin lacks the classroom shell's skip link, route announcements and theme toggle. |
| 5 | Error Prevention | 2 | Sign-out, which is harmless, asks for confirmation. One tab tap silently throws away pending AI Settings changes. |
| 6 | Recognition Rather Than Recall | 2 | Desktop is labelled. Phones get six unlabeled icons, and so does desktop at 200% zoom or with enlarged text. |
| 7 | Flexibility and Efficiency | 2 | No skip link, so 9 Tab stops come before page content. No shortcuts. |
| 8 | Aesthetic and Minimalist Design | 3 | Restrained and consistent with the design tokens. The white Visit Classroom button outshouts the active nav, and the drawer is mostly empty. |
| 9 | Error Recovery | 2 | A page crash or failed code chunk replaces the whole admin frame with a bare error screen. |
| 10 | Help and Documentation | 1 | No help anywhere in the frame. The only guidance is the drawer's "use the tabs" sentence. |
| **Total** | | **23/40** | **Acceptable** |

## Design Specificity Verdict

**Design review:** Well built, but it could belong to any product. Swap the wordmark and the purple and it's a stock shadcn dashboard: a branded sidebar with logo, text nav and footer, plus a top bar, hamburger and bottom tabs on phones.

What's genuinely plato is the boundary: a fixed purple admin "control room" set against a classroom that each school brands for itself. The token discipline and the care in the drawer are plato's too.

Two gaps stand out:
- **It shows nothing of plato's own state.** It doesn't say when the AI provider isn't configured, when invites or wait-list entries are waiting, or when lessons are still drafts. The knowledge base, a core AI input, hides under a palette icon called Customizer.
- **It doesn't carry one nav design across screen sizes.** It swaps in a different one at each size: a labelled sidebar, icon-only tabs, and a drawer with no navigation in it.

**Detector:** The frame itself is clean.
- **File scan:** 0 findings on `AdminLayout.jsx` and on all 19 files in `client/src/pages/admin/`, even with ignores turned off. This scan only pattern-matches source text, so contrast and tiny-text checks didn't run there.
- **In-browser scan, five views:** phone light, phone dark, phone `/plato/ai`, desktop, and phone with the drawer open. 0 findings in the frame.
- **One finding outside the frame:** a `nested-cards` hit on `/plato/ai`, the `#bedrock-credentials-warning` callout inside a card (`client/src/pages/admin/AdminAI.jsx:344`). It's an inline warning, not a second card, so it isn't a real design problem. It only appears because the local database has no AWS credentials. A second scan driving the browser directly found exactly the same result.
- **How the two assessments line up:**
  - The detector backs up what the review praises: none of the usual anti-patterns, and no contrast or tiny-text failures in the frame.
  - It caught nothing the review missed.
  - It can't see the review's main findings, because those are about behaviour: scroll carry-over, focus, landscape clipping, icon recognition.
  - Its design-system checks didn't fire even on deliberately planted off-palette colours, so a clean scan tells you nothing about whether the frame sticks to the design tokens.

**Visual overlays:** The detector overlay worked in a headless browser on this machine, so nothing was visible in the user's Chrome, which runs on Windows and can't reach this machine's localhost.

## Overall Impression

Careful, accessible chrome with a generic face. At any one screen size it's tidy. The problems are at the seams:
- **Between pages:** scroll position carries over and focus isn't moved.
- **Between screen sizes:** three nav patterns, and landscape phones get a sidebar that cuts off Sign Out.
- **Between the admin and classroom frames:** the classroom has a skip link, route announcements and a theme toggle; admin has none of them.

The biggest opportunity is cheap: one hook that runs on every page change fixes the problem every admin feels.

## What's Working

- **The drawer is built right.** Focus starts on Close and stays inside. Esc, tapping the backdrop and changing page all close it, and focus returns to the menu button. The sign-out confirmation opens with Cancel focused. It respects phone safe areas and reduced-motion settings, and it scrolls at 568×320, where the sidebar can't.
- **One chrome, one set of tokens.** The sidebar, top bar and drawer share `--sidebar`, focus rings are tuned to each surface, and dark mode is designed rather than inverted. That's what makes admin read as its own control room.
- **Sound structure.** The frame draws before the page loads (the spinner stays inside the content area). Landmarks are named, `aria-current="page"` is set, and page titles update per route.

## Priority Issues

**[P1] Changing page doesn't reset the view**
- **What:**
  - On phones, the scrolling content area (`AdminLayout.jsx:225`) persists across pages. On desktop the window scrolls instead. Neither resets.
  - Measured: scroll Customizer to 600px, tap Home, and you land at 563px. On desktop you land at the bottom of the next page.
  - Nothing moves focus, and nothing announces the new page: `client/src/lib/routeTitles.js:10-14` only names classroom routes.
  - There's no skip link. The classroom shell has both a skip link and a focusable `<main>` (`client/src/components/AppShell.jsx:59-61,175`).
- **Why it matters:**
  - Admins land mid-page and miss the heading and any banners.
  - Keyboard users have to Tab through 9 stops to reach content (6 nav links, Visit Classroom, Sign Out, version link).
  - Screen-reader users hear nothing when the page changes.
- **Fix:**
  - On every page change, reset scroll and move focus to a `<main id="main-content" tabIndex={-1}>`.
  - Add the admin routes to the announcer.
  - Add a "Skip to main content" link.
  - Move the version link after the content in Tab order.
- **Suggested command:** `/impeccable harden`

**[P1] Phone navigation relies on memory**
- **What:**
  - The bottom bar is six icons whose labels exist only for screen readers and as `title` tooltips (`AdminLayout.jsx:236-257`). Tooltips never appear on touch or on keyboard focus.
  - The hamburger opens a drawer whose only guidance is "Use the tabs at the bottom of the screen to move between admin pages" (`:139-141`).
  - The breakpoint is measured in rem, so desktop users at 200% zoom or with enlarged text get this layout too. At 640px wide there's room for labels, but none are shown.
- **Why it matters:**
  - Palette for Customizer, Sparkles for AI Settings and Puzzle for Plugins aren't obvious.
  - The people who most need labels, low-vision users zooming in, are exactly the ones who lose them.
  - This is the trade-off flagged on PR #21.
- **Fix:**
  - Keep icon-only only where width forces it: show a 12px label under each icon from about 30rem wide, which covers zoomed desktops and landscape phones. Alternatively, label every tab and cut to 5 tabs, moving Plugins to an account menu.
  - Replace the hamburger with an account button that opens one sheet: email, Classroom, theme, Sign Out, version.
  - That also removes the "use the tabs" sentence and the duplicate Classroom button.
- **Suggested command:** `/impeccable adapt`

**[P2] The layout switches on width alone, so landscape phones and tablets get the wrong one**
- **What:**
  - The sidebar appears at 768px and wider whatever the height. It's fixed to the screen height with no scrolling (`AdminLayout.jsx:179`).
  - At 844×390, the email, Sign Out and version link sit below the screen edge and can't be reached.
  - At 768 (iPad portrait) the content area shrinks to 544px and the Users table is cut off after "Last a…".
  - On short phone screens, both bars stay pinned. The rule meant to unpin them, `.admin-bottom-nav { position: static }` (`client/src/index.css:375-378`), does nothing, because the layout's full-height column pins the bar, not CSS positioning.
- **Why it matters:** Turning a phone sideways is how an admin reads the wide Users table, and that's exactly where Sign Out becomes unreachable.
- **Fix:**
  - At minimum, let the sidebar scroll (`overflow-y-auto`).
  - Better: only use the fixed sidebar when the screen is also tall enough (the project's own `34em` short-screen definition), or switch to it at `lg` instead.
  - Make the short-screen rule work by letting the page grow and scroll normally below `max-height: 34em`.
- **Suggested command:** `/impeccable adapt`

**[P2] The frame doesn't protect the admin's work**
- **What:**
  - The error boundary sits above the whole route tree (`client/src/App.jsx:121`). Any error on an admin page, or a code chunk that fails to load, replaces the entire frame with "Something went wrong". Its only exits are Reload and "Go to lessons", which goes to the classroom.
  - The boundary's own code comment names failed admin chunks as an expected case.
  - Pending AI Settings changes (e.g. switching Bedrock to Cloudflare) are discarded by one tab tap, with no warning.
  - Sign-out, which loses nothing, gets a confirmation (`AdminLayout.jsx:262-280`).
- **Why it matters:** Every merge to `main` redeploys Cloud Run, which removes the old code chunks. Admin tabs left open across a deploy will hit this; it isn't an edge case. The one safeguard protects the action that needs it least.
- **Fix:**
  - Put an error boundary around the page outlet, reset on page change, so the nav and Sign Out survive and the error screen offers "Try again" plus admin links.
  - Add a "you have unsaved changes" prompt (React Router's `useBlocker`) to forms with pending changes.
- **Suggested command:** `/impeccable harden`

**[P2] Names drift and the emphasis points the wrong way**
- **What:**
  - One place has three names: Home, Dashboard and Admin Dashboard. Another has two: Classroom and Visit Classroom.
  - The `Visit Classroom` button (`AdminLayout.jsx:192-198`) is the loudest thing in the chrome.
  - Admin has no theme control: the toggle exists only in the classroom shell and on the login page, though DESIGN.md says admin follows the theme.
  - AI health, waiting invites and drafts never show up in the nav.
- **Why it matters:** An admin frame should answer "where am I?" and "is anything wrong or waiting?" at a glance. This one only answers the first, and three names for one place is a small, constant tax.
- **Fix:**
  - One name per place: "Dashboard" and "Classroom".
  - Turn Visit Classroom into an outline button with an exit icon.
  - Put the theme toggle in the account area.
  - Consider status dots or counts on AI Settings, Users and Lessons.
- **Suggested command:** `/impeccable clarify`, `/impeccable quieter`, `/impeccable shape`

## Persona Red Flags

**Alex (power user)**
- Invite Users is the 10th Tab stop on `/plato/users`.
- Every page change after scrolling lands mid-page.
- Checking a colour change takes three hops: Customizer → Visit Classroom → back, which lands on Home, so you navigate to Customizer again.
- At 1920px wide, content stops at 896px and hugs the left, leaving about 40% blank beside a 6-column table.
- No shortcuts, and no "View as User" entry on the Users page.

**Sam (screen reader, keyboard, zoom)**
- Nothing is announced and focus doesn't move after navigating. `<main>` has no id to skip to.
- At 200% zoom the nav becomes unlabeled icons, with no tooltip on focus.
- At 844×390, Sign Out can't be reached by keyboard.
- "plato 1.8.0" opens GitHub in a new tab without saying so, and comes before the page content in Tab order.
- With large text, the drawer's close icon stays 24px, and the email is cut off with no way to read it in full.
- While a page loads, a `<main role="status">` loading screen sits inside the frame's own `<main>` (`App.jsx:66-70`).

**Casey (mobile, one hand)**
- The hamburger is top-right, out of thumb reach, and the drawer slides in from the left.
- Tabs are guess-the-icon, 64×44 targets set edge to edge. A mis-tap can throw away pending settings.
- Classroom appears twice (top button and drawer button), and so does Home (logo and tab).
- In landscape, the pinned bars take 28% of a 667×375 screen.
- Visit Classroom and Sign Out jump 33px when the version row finishes loading (`:161,209`).

## Minor Observations

- **Stale docs and code:**
  - DESIGN.md's Navigation paragraph still says the drawer reuses the nav items.
  - CLAUDE.md's admin nav order leaves out AI Settings.
  - `NavItems` still takes a leftover `onClick` (`:35,41`) and ignores the icons, so desktop doesn't share the phone's icon set.
- **Icons:** the hamburger and close icons are hand-drawn SVGs in fixed pixels (`:109,133`) rather than lucide's `Menu` and `X`, so they don't scale with text.
- **Inconsistencies:**
  - The logo is a link on mobile but not on desktop.
  - The nav landmark has a different name in each layout ("Admin navigation" vs "Admin primary navigation").
- **Small styling issues:**
  - Hover and active highlights are only one step apart (10% vs 20%, `:43-47`).
  - Sign Out is an 18px-tall target, nudged 1px out of line with the email.
  - The bottom-tab focus ring is square and overlaps the next tab's top border, unlike the rounded sidebar ring.
- **No sign-out message:** after signing out, the login page doesn't say you've been signed out.

## Questions to Consider

- If a sighted admin at 200% zoom gets six unlabeled icons, is icon-only really a mobile decision, or an accessibility one?
- Which two or three things should the frame know without opening a page: AI provider reachable, invites waiting, drafts pending? Should the nav show them?
- Should Visit Classroom be a door or a preview, one that brings you back to the exact admin page you left?
- Does the hamburger need to exist, or should the top bar's right side be an account button like the classroom's?

## Run Notes

- **Viewports:** phone 390×844; the 767/768 switch point; 1024, 1280 and 1920 desktop; landscape 844×390, 667×375 and 568×320; 200% and 400% page zoom; 150% and 200% enlarged text. Light and dark, all six admin pages.
- **Flows:** keyboard traversal, the drawer, sign-out, and the classroom round trip.
- **Not tested:**
  - No real touch device or screen reader; assistive-tech behaviour is inferred from the accessibility tree.
  - The local server reports no version number, so the design review faked that one response in its own browser to show the version row as production does.
- **Isolation:** the detector results arrived before the design review finished. They were held back, and the review never saw them.
