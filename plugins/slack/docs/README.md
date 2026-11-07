# Slack plugin

plato plugin that adds Slack DM invites for the learner-onboarding flow.

## Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Add OAuth scopes: `users:read`, `users:read.email`, `channels:read`, `groups:read`, `chat:write`, `im:write`.
3. Install to your workspace, copy the **Bot User OAuth Token** (starts with `xoxb-`).
4. In plato, go to **Admin → Plugins → Slack**, paste the token, click **Test Connection**, then **Connect**.
5. The Invite Users dialog on the Users page now shows a Slack tab.

## Settings

| Field | Type | Notes |
|---|---|---|
| `botToken` | string (writeOnly) | Stored encrypted at rest in DynamoDB. |
| `workspaceName` | string | Display name; populated on successful test. |
| `connected` | boolean | True once auth.test succeeds. |
| `autoInviteEnabled` | boolean | Add new plato accounts to a channel (#379). Off by default. |
| `autoInviteChannelId` / `autoInviteChannelName` | string | The channel for auto-invite. |

## Add new accounts to a channel (#379)

When it's on, every new plato account (the `userCreated` hook) is looked up
in the workspace **by email**. A member is added to the chosen channel with
`conversations.invite`. plato doesn't send workspace invitations, so someone
not in the workspace is recorded as "Not in the workspace".

- **Scopes:** `users:read.email`, plus `channels:manage` for a public channel
  or `groups:write` for a private one. The app must be in the channel.
- **Results** are kept per user in `userMeta:slack.autoInvite`
  (`invited` / `not_in_workspace` / `failed`, with Slack's error code). The
  settings panel lists recent results with **Retry**, and **Retry everyone
  not added** picks up people who joined the workspace later.
- **Atomic ownership:** the signup hook, row Retry and Retry everyone not added
  use the same `updateUserMeta` compare-and-set claim (plugin API **1.6.0+**).
  A pending record holds a cryptographically random `attemptId`, `startedAt`
  and a **60-second lease**. A live lease blocks another call to the same
  channel; a completed successful invite to that channel is skipped.
- **Recoverable attempts:** after lease expiry, Retry can claim an abandoned
  pending attempt. Legacy pending records without a lease are reclaimable.
  Choosing another channel can take over immediately. The lease suppresses
  duplicate calls; the attempt ID decides which result may be saved and does
  not depend on clock accuracy. Slack's `already_in_channel` counts as success.
- **Fenced outcomes:** only the current attempt can record success or failure.
  Late results from an old attempt are discarded in either arrival order,
  including a stale success after the current owner's failure. Deleting an
  account or its Slack metadata during an attempt prevents its outcome from
  recreating that data. Unrelated metadata edits are preserved. At most one
  previous attempt (status, channel, time and error) is retained for diagnosis;
  history and internal attempt IDs are excluded from the recent-results API.
- **Retry counts every selected user:** responses include `invited`,
  `not_in_workspace`, `failed`, `skipped`, `in_progress` and `conflict` counts.
  A storage failure or exhausted comparison retries for one user does not
  stop the remaining users. Retry all may select from lagging reads; the strong
  claim remains authoritative. An invited result for a different channel is
  eligible when the configured channel changes.
- **Panel:** live pending rows say **In progress** and hide their row Retry.
  Expired pending rows say **Not finished** and offer Retry when results are
  refreshed. Retry everyone not added can also recover expired attempts, and
  its status message includes skipped, in-progress and conflicted counts.
- **Signup waits for the invite** (each Slack call gets one 4 s try, with no
  Slack SDK retries). A crash or outcome-storage failure can leave a pending
  record for a later retry; hook errors never reject account creation.

## Routes (admin-only)

- `POST /v1/plugins/slack/admin/test` — validate a bot token (no persistence)
- `GET  /v1/plugins/slack/admin/users?q=` — search workspace users
- `GET  /v1/plugins/slack/admin/channels` — list public channels
- `GET  /v1/plugins/slack/admin/channels/:id/members` — list channel members
- `POST /v1/plugins/slack/admin/invites` — send DMs (max 200 per batch)
- `GET  /v1/plugins/slack/admin/auto-invite` — recent auto-invite results
- `POST /v1/plugins/slack/admin/auto-invite/retry` — `{ userId }` or `{ all: true }`

## Disabling

Toggle off in **Admin → Plugins → Slack**. The plugin's routes return 404 while disabled and the row-action button hides on the Users page. Settings are preserved — re-enabling restores the previous bot token.
