# Lesson publishing workflow — local verification

Implemented the approved integrated publishing recommendation on `feat/lesson-publishing`. Work is local and uncommitted; no push, merge or deployment was performed.

## Behavior

- A reviewed draft offers **Save privately** (default) and **Save & make public**. Finalization sends the exact preview and chosen status in the same versioned write.
- Saved private lessons offer **Make public** in the editor. Editor and lesson-list Private/Public buttons open **Visibility & Sharing**.
- Existing shares survive publication and returning to private. A lesson with an empty share list can be made private without adding recipients.
- Editor visibility-only changes use the authoring queue, so the next content save uses the acknowledged version and retains any unsaved preview.
- Unknown saves retain the original preview, visibility choice and operation ID. Recovery displays the pending choice while the header keeps the confirmed state. Retrying does not invoke inference.
- Dialog errors remain in the dialog and retain the selection. Controls prevent duplicate submissions and dismissal while saving. Confirmed validation rejections can be corrected; conflicts preserve work and offer a saved-version reload.

## Validation

| Command | Result |
| --- | --- |
| `npm test` | Client: 708 passed. Server: 889 passed, 3 optional tests skipped; no failures. |
| `npm run lint` | Exit 0; no errors, 19 client warnings. Server lint clean. |
| `npm run build:client` | Passed; existing main-bundle size warning remains. |
| `npm --prefix client run test:browser:publishing` | 15 passed in Chromium. |
| `node --test --test-name-pattern='preserves lesson shares' client/tests/browser/admin-responsive.test.js` | Passed; public/private round trip at 320px and 1280px. |
| Impeccable detector on the three changed UI components | No deterministic findings. |
| `git diff --check` | Passed. |

The three optional server skips require `POSTGRES_TEST_URL`: PostgreSQL branding transactions, concurrent persistence, and the production HTTP entrypoint save-observability test. PostgreSQL was not provisioned for this UI change.

The publishing browser suite covers private-by-default creation, explicit publication, withheld acknowledgement, duplicate keyboard activation, response loss both before and after commit, same-tab reload, editor version progression, unsaved-preview preservation, corrected validation errors, conflicts, pending dialog choices, empty share lists, keyboard-operated sharing, and 320px/1280px light/dark layout checks.

One browser test uses the real local Hono API and a disposable SQLite database. It confirms that the saved record has public visibility, exact reviewed markdown and version 2 after one final write. Preview generation is intercepted with a synthetic response; no paid model calls were made.

The initial browser regression failed at the missing public-save control. The queue regression failed because rejected metadata writes could not be corrected. Additional regressions reproduced a stale success-recovery error and both independent review findings before their fixes. Final runs passed.

## Review and rendered evidence

An independent read-only reviewer found two important issues: the recovery dialog could show Private while retrying Public, and empty-share public lessons could not be made private. Both were fixed and covered by failing-then-passing regressions. No deferred review findings remain. The full diff was reviewed again after these corrections.

Screenshots and command logs are generated under the ignored `output/playwright/lesson-publishing/` directory:

- [Reviewed draft, desktop light](../../../output/playwright/lesson-publishing/editor-1280-light.png)
- [Reviewed draft, narrow dark](../../../output/playwright/lesson-publishing/editor-320-dark.png)
- [Saved private lesson, desktop](../../../output/playwright/lesson-publishing/saved-editor-private.png)
- [Saved public lesson, desktop](../../../output/playwright/lesson-publishing/saved-editor-public.png)
- [Private status control, narrow lesson list](../../../output/playwright/lesson-publishing/list-320-private.png)
- [Public status control, narrow lesson list](../../../output/playwright/lesson-publishing/list-320-public.png)

This is local code, browser-render and API/SQLite evidence. It does not establish deployed behavior, PostgreSQL qualification, physical-device behavior, or assistive-technology testing.
