# Classroom Customizer remediation — 2026-10-25

**Evidence archive:** Historical raw captures, logs, and run records are retained privately in archive `googleplato-untracked-curation-20261027T055535Z` (`evidence-1730.tar.gz`). Paths beginning `output/` or `.mobile-ux/` below identify archive members.

Implemented on `fix/classroom-customizer`, based on `d8a4718`. The scope is the
confirmed review findings plus the requested device-based default theme. This
record covers local implementation and validation; no deployment, real email,
or AI inference was performed during validation. Existing unrelated untracked
paths remain present.

| Review finding | Implemented behavior | Main implementation |
| --- | --- | --- |
| 1. Wordmarks, unbounded logos, blocking downloads and shared-record capacity | Accept source images up to 5 MiB; preserve proportions and transparency within 1024 × 128 pixels; reduce further to fit a 128 KiB encoded cap. Store images in separate `_branding` records. Public branding returns a content-addressed URL with immutable caching and an ETag. | `client/src/lib/logoUpload.js`, `server/src/lib/branding.js`, `server/src/routes/content.js` |
| 2. Missing server validation | Require a JSON object, trim names to at most 100 characters, reject control characters, validate image data and size, and allow only primary/accent theme fields. Reject external logo URLs and active/external SVG content. Sanitize legacy public reads. | `server/src/routes/admin.js`, `server/src/lib/branding.js` |
| 3. Email contrast, HTML and sender names | Select a readable foreground for brand backgrounds; use current classroomName with legacy fallback; escape classroom and inviter names; encode the SES sender display name as bounded UTF-8 MIME words and declare UTF-8 in the subject/body. | `server/src/lib/email.js` |
| 4. Unsaved Styles edits | Compare against the last acknowledged save; disable unchanged saves; clear feedback on edits; protect navigation, history traversal and reloads; provide Discard changes and a staged Reset to defaults. Failed saves retain edits. | `client/src/pages/admin/AdminStyles.jsx`, `client/src/main.jsx` |
| 5. Coupled loading failures | Styles and Knowledge have independent loading, error and retry state. A pending or failed Knowledge request does not block editing Styles. | `client/src/pages/admin/AdminCustomizer.jsx` |
| 6. Unexpected inherited red accent | Add Match primary and omit the stored accent in that mode. New classrooms use it; existing explicit accents remain independent. | `client/src/pages/admin/AdminStyles.jsx`, `server/src/lib/seed.js` |
| 7. Preview drift | Hold the last complete color while typing, accept shorthand on blur/save, display classroom identity in both previews, use real neutral outline buttons, and isolate dark utility variants from a light preview. | `client/src/pages/admin/AdminStyles.jsx`, `client/src/index.css` |
| 8. Focus, blank names, descriptions, stale requests, route state and test isolation | Restore file-input focus on logo removal; clear file selections for repeat uploads; use the trimmed name or plato; connect color notes to inputs; fence stale branding requests and their callers; derive Knowledge editor state from its URL; give isolated theme tests their own authentication fixture. | Customizer components, `client/src/lib/publicBranding.js`, `client/src/components/AppShell.jsx`, `server/tests/routes/admin.test.js` |
| Theme preference decision | Follow the device before first paint and on subsequent device changes until a visitor saves light/dark. Preserve explicit choices, cross-tab updates, and a session choice when storage writes fail. | `client/index.html`, `client/src/lib/theme.js`, `DESIGN.md` |

The navigation guard uses React Router's data-router blocker, with the existing
route definitions retained in App. The full admin navigation/responsive suite
was included because the router entry point changed.

Logo metadata and asset reads request strong consistency where the database
adapter supports it, preventing an acknowledged DynamoDB upload from briefly
returning a missing image. Safe legacy inline logos migrate on the next theme
save. Previously stored oversized or unsupported SVGs need re-uploading through
the Customizer. Old content-addressed assets remain available to cached pages;
removing a logo clears its current reference. This change does not provision
object storage or change database schemas.

Validation was run against the final implementation:

| Check | Result |
| --- | --- |
| `npm test` — client | 517 passed, 0 failed |
| `npm test` — server | 729 passed, 0 failed, 2 skipped |
| Isolated theme route tests | 4 passed independently with the missing authentication fixture supplied |
| Chromium Customizer and existing admin responsive suites | 14 passed |
| WebKit targeted Customizer scenarios | 6 passed |
| `npm run lint` | 0 errors; 20 client warnings |
| `npm run build:client` | Passed; Vite reports a 551.29 kB entry chunk (175.85 kB gzip) above its 500 kB advisory threshold |
| `git diff --check` | Passed |

Browser coverage includes save/discard/reset, failed saves, sidebar and tab
navigation, Back/Forward and reload cancellation, incomplete hex input,
primary/accent linking, independent load failures/retry, pending Knowledge loads,
1200 × 300 wordmarks, proportional SVG conversion, same-file reselection,
removal focus, 320/390 px widths, both preview themes inside light/dark admin
pages, canonical Knowledge editor URLs, system-theme changes, and retained
explicit theme choices. A real SVG asset and its generated favicon were checked
down to the expected logo pixel. Browser fixtures use an isolated temporary
SQLite database; API route tests also use bounded mock records. SES tests capture
SDK commands without sending mail, and compare foreground choices across 4,096
colors against the classroom implementation.

The PostgreSQL integration suite and PostgreSQL HTTP-startup test were skipped
because `POSTGRES_TEST_URL` was not configured. The retired Firestore rules suite
was also skipped because `FIRESTORE_EMULATOR_HOST` was not configured (Node reports
this as a skipped suite, not as an additional skipped client test). No physical
device, assistive-technology, production-database, or live SES qualification is
claimed.

Evidence is in `output/playwright/customizer-2026-10-25/`: `chromium/` and `webkit/`
contain desktop light/dark and phone screenshots, and `validation/` contains the
final test, lint and build logs. The browser suite can be rerun with
`npm run build:client && npm --prefix client run test:browser:customizer`.

## Superseded the same day

[classroom-customizer-followups-2026-10-25.md](classroom-customizer-followups-2026-10-25.md)
changes some statements above. Logos saved by earlier versions, including
oversized ones and SVGs from design tools, stay visible and are never deleted by
an unrelated save. Replacing or removing a logo deletes the previous asset.
Plain sender names are sent without MIME encoding, and other ASCII names are quoted.
