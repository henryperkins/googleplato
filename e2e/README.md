# End-to-end & accessibility tests

Playwright + [axe](https://github.com/dequelabs/axe-core) against the real app:
a fresh `dev-sqlite` server on port 3490 with a unique temporary SQLite database and the
**mock AI provider** (`AI_PROVIDER=mock`, `server/src/lib/ai-mock.js`), so chat
flows are deterministic and need no AWS credentials.

```bash
npm ci && npm run build:client # root workspace lockfile, Node 24
cd e2e && npm ci && npx playwright install chromium
npx playwright test             # or: npm run test:headed
```

The bar (`helpers.js` `expectAccessible`): **no serious or critical WCAG 2.1
A/AA violations** on any page or dialog, at desktop (1280×800) and mobile
(Pixel 7) sizes.

- `tests/a11y.spec.js`: axe on every public, learner, and admin page, every
  admin dialog, and the lesson chat both while the coach streams and after.
- `tests/flows.spec.js`: keyboard-only flows. A learner completes a lesson
  (Cmd/Ctrl+Enter to send, Alt+Arrow through messages); the admin skip link;
  long dialogs fit the viewport.

`global-setup.js` seeds data through the real API (a course, two lessons, a
group, a custom field) plus a learner via `server/scripts/create-dev-user.js`.
The mock coach emits the modern assessment contract through the real server
assessment and signed atomic-save pipeline. A message containing `MOCK_COMPLETE`
provides deterministic mock evidence for the authored criteria. Missing-tag
repair, source guards and receipt validation remain active. This does not prove
real-provider teaching quality.

The login helper and the public-page checks serve a local stub for the
Google sign-in chunk (`firebaseAuth-*.js`, as the fork's browser suites do), so
the suite makes no requests to Google and `networkidle` waits only on this app.

Every spec shares that one server and database, so the suite never retries a
failed test (`retries: 0`): a retry would run against the state the failed
attempt changed. A spec that passes alone but fails in the full run depends on
another spec's data; isolate it rather than retry it.

Override `E2E_PORT` for an unused port and optionally `E2E_DB` for a caller-owned
database path. The runner never deletes a supplied database; choose a new path
for a clean run. Default `plato-e2e-*` temporary directories are retained for
diagnostics and can be removed by their owner after review. Database paths travel
through environment variables, never shell interpolation.

**Adding a page or dialog?** Add it to `a11y.spec.js` in the same PR. axe
catches markup problems, not everything; still walk new UI with the keyboard
and a screen reader (see CLAUDE.md "Accessibility is required").
