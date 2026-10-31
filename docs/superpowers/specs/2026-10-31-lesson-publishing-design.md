# Lesson publishing

Approved in conversation on 2026-10-31: implement integrated publishing and a visibility shortcut in the lesson list.

Admins should be able to review a preview and choose **Save privately** (the default) or **Save & make public**. Publishing explains that the lesson is visible to all learners in the classroom. Existing saved lessons show their visibility in the editor and offer **Make public**. Both the editor's visibility control and the list's Private/Public button open the existing sharing dialog.

## Approaches

- Expose the existing dialog from the list status and editor: smaller, but creating and publishing remain separate.
- Integrate publishing with preview saving and add the same shortcuts: selected because authors can finish the task where they review the content.

## Behavior and constraints

- Keep draft autosaving and preview generation separate from final content saves.
- Save the exact reviewed preview and requested visibility in one versioned write, after queued autosaves finish.
- Keep existing shares when publishing and when returning to private.
- Send editor visibility-only changes through the same save queue, preserving its acknowledged version.
- Show success and the new visibility only after a confirmed server response.
- Retain the preview, chosen visibility and operation identity through failures and same-tab recovery. Retry persistence without another AI call.
- Preserve existing server validation, conflict protection, authentication and private defaults. Add no dependencies or database changes.
- Keep controls named, keyboard accessible and usable at narrow widths in both themes.

## Delivery

Implement and verify locally. This approval does not include committing, pushing, merging or deployment.
