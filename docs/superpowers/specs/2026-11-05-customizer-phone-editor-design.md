# Customizer phone editor and authoring labels

Approved scope: the user selected phone editing and clearer labels after the critique, then invoked `@impeccable adapt clarify` to execute the concrete proposal in this conversation.

Improve the existing editor at 390 x 844 and 320 x 740 while preserving the desktop workspace, exact-preview save contract, mode switching, and unsaved-change protection. Keep the existing assistant-first visual emphasis and all unrelated local work.

Use a compact phone header, one introductory instruction, native disclosure for detailed writing/review help, a non-sticky unchanged-state save area, and a Back to editing action near the preview. At least several lines of editable text should be visible on entry. The assistant entry actions become Create with assistant / Edit with assistant; direct entry becomes Write or paste text / Edit text; the Conversation tab becomes Assistant.

Approaches: selected scoped adaptation keeps the current single-page editor and preview. A separate editor/preview route would add navigation and state complexity; hiding global navigation would change the shared admin shell. Both are outside this pass.

No new draft recovery, data model, AI generation, backend, or deployment configuration changes. Chromium and WebKit browser tests use an isolated local SQLite service and stub AI responses. Physical-device testing remains unavailable. The user subsequently authorized Git publication and synchronization of the primary checkout's `main` with remote; the [publication record](../../reviews/customizer-polish-2026-11-05.md#publication-qualification) documents that stage.
