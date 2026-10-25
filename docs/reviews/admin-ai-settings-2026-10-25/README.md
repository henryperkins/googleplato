# AI Settings layout, hardening, and polish

This pass applies Impeccable layout, clarify, distill, harden, and polish to `/plato/ai`, preserving the existing administration design system. The baseline is `main` at `d8a4718`.

Provider descriptions are shorter, and the model and connection sections share the page alignment instead of nesting outlined and filled panels. The raw model ID moves into a keyboard-accessible disclosure. Reasoning, latency, paid-access requirements, and test charges remain visible. Pending changes, test feedback, and actions now form one compact review area. Connection copy explains that classroom access changes immediately, independently of saving the provider and model.

The saved configuration remains distinct from pending provider/model choices and the last tested configuration. The Bedrock instance-role caveat, credential blockers, connection recovery, and disconnect confirmation remain available.

## Hardening

- Unsaved provider/model choices survive internal navigation and reload in the same tab, scoped to the signed-in administrator and exact saved-settings version. Blocked session storage falls back to memory for navigation and explains the reload limitation. Native departure warnings protect pending choices. Save and explicit discard clear both ordinary and OAuth-handoff drafts; a later callback cannot recreate discarded choices.
- Connection actions retain keyboard focus while waiting. If a successful action removes its control, focus returns to the stable connection heading. Focus stays where the administrator deliberately moved it during the request.
- Leaving AI Settings invalidates pending UI responses, including a late authorization redirect. A reply cannot pull an administrator away from the page they selected.
- Incomplete settings responses produce a recoverable initial error or preserve the current form. Unconfirmed saves keep pending choices. Connection completion messages require a refreshed response with explicit OAuth status; a still-pending revocation or unchanged connection cannot be reported as completed.
- A denied `sessionStorage` getter now stays inside the shared authentication reader's existing error boundary, allowing ordinary authenticated admin requests and the in-memory draft fallback to continue.
- Account names isolate bidirectional text without rewriting it. Long Arabic, Chinese, emoji, and Latin content wraps within the existing page layout.

The related regression assertions were reproduced against the earlier implementation before the fixes. No server authorization, credential ownership, provider-call semantics, or production configuration changed.

## Rendered evidence

These captures use the production client build, an isolated SQLite server and synthetic admin login, and controlled AI settings/connection responses. No provider calls or production writes were made. Phone captures show the initial viewport of the internally scrolling admin page, not the complete form.

| View | Before | After |
| --- | --- | --- |
| Desktop, 1440 × 1100 | [Before](desktop-before.png) | [After](desktop-after.png) |
| Phone, 390 × 844 | [Before](phone-before.png) | [After](phone-after.png) |
| Dark phone, 390 × 844 | — | [After](phone-dark.png) |

Additional phone captures show [restored pending choices](restored-draft-phone.png), [an unconfirmed disconnect that keeps the form](unconfirmed-disconnect-phone.png), and [long mixed-script account content with a controlled provider error](long-account-error-phone.png). The after captures use the final hardened build.

In the matched connected-account fixture, the phone main area's scroll height fell from 1372 px to 1185 px; tablet scroll height fell from 1032 px to 921 px. These measurements describe the fixture, not every configuration.

## Validation

- Production client build passed.
- Full Node 24 suites passed: 520 client tests and 725 server tests, with zero failures or skips and a disposable PostgreSQL 17 instance.
- All 15 admin browser regressions passed. They cover responsive navigation, keyboard model disclosure, test versus save, draft restoration and explicit discard, blocked storage, delayed replies after navigation, incomplete load/save/connection responses, account/revocation/disconnect focus, discarded OAuth choices, and still-pending revocation.
- Fourteen additional rendered checks covered light/dark themes, long account names, missing credentials with expanded manual configuration, pending account selection, revocation, Bedrock, controlled test failures, and expanded model IDs. Enlarged root text at 200% was checked at 320, 480, 768, and 1440 px. No document or main-pane horizontal overflow was found; controlled test errors kept feedback visible and focus on Test connection.
- Three final path checks confirmed that deliberately moved focus stays put, a no-op disconnect reports an unconfirmed result while retaining the chosen model and focus, and navigating away and back restores the draft. Browser console errors were absent in these controlled paths.
- Lint passed with zero errors and 20 existing warnings. The final Impeccable detector returned no findings, and `git diff --check` passed.
- Independent focused source review found no remaining material issues after the reproduced cases were fixed. The final build was then checked in fresh desktop and phone renders.

Evidence is local Chromium browser automation. Physical devices, screen readers, real Cloudflare authorization, billable model tests, production deployment, and hosted Cloud Build were not exercised.
