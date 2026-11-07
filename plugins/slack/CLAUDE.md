# plugins/slack/ — Claude / agent instructions

Lets admins invite learners via Slack DM, and adds new accounts to a chosen channel (`server/auto-invite.js`, the `userCreated` hook, #379).

## Local invariants
- The bot token is `writeOnly` in `settingsSchema` — never echo it back in a `GET` response. The plugin's settings record holds it; the `/v1/plugins` endpoint strips writeOnly fields for non-admin callers.
- Settings live at `_system:plugins:activation.slack.settings`. Don't write to the legacy `_system:settings.slack` location — `onActivate` migrates that on first boot, then leaves it alone.
- The Bolt SDK (`@slack/web-api`) stays in `server/package.json` because the plugin folder gets bundled into the same Lambda and shares its node_modules.
- All admin routes are mounted under `/v1/plugins/slack/admin/*`. Don't re-register Slack routes on the core `admin` router.
- The settings panel saves with `{ ...settings, … }`. The client never sees `botToken`, and the host keeps a writeOnly value the body leaves out (send `null` to clear it, as Disconnect does). Disconnect confirms first, clears only the token/workspace/connection fields, and preserves the auto-invite configuration for reconnecting.
- Connect saves only the exact token that passed Test Connection, with that test's workspace name; editing the token, or a test that returns after an edit, withdraws Connect.
- Admin route failures use `slackErrorBody()`: Slack's `code` and a missing scope's `needed`, never the token. A failed channel load must keep the saved channel (and its name) selectable rather than blanking the field.
- Auto-invite claims every attempt atomically through SDK `updateUserMeta` (API 1.6.0+), shared by signup, row Retry and Retry all. A random attempt ID owns the outcome; a 60-second lease blocks a live same-channel call. Successful same-channel records are skipped, expired/legacy pending records are reclaimable, and a new channel may take over. `already_in_channel` remains success.
- Re-read the account after a successful claim and remove only that attempt's orphaned first claim before calling Slack. A CAS retry must never recreate metadata that disappeared after an earlier comparison.
- Only the owning attempt may publish an outcome; discard every stale success or failure, including stale success after the current owner's failure. Outcome updates must not recreate deleted accounts/Slack metadata. Preserve unrelated metadata, retain at most one previous attempt, and omit that history/internal owner IDs from list payloads.
- Retry handles each selected user independently and reports invited, not-in-workspace, failed, skipped, in-progress and conflict counts. The UI identifies live attempts as In progress and hides their row Retry. A lease is duplicate-call suppression, not an exactly-once Slack guarantee.

## When changing this plugin
- If you change the manifest's `capabilities`, update `docs/plugins/CAPABILITIES.md` if you add a new capability not yet in the vocabulary.
- If you add a new slot or hook, declare it in `extensionPoints` AND in `capabilities` — the registry will reject the plugin otherwise (`plugin_capability_missing`).
- Test changes locally with `node dev-sqlite.js` before pushing — the plugin host runs in dev exactly like prod.
