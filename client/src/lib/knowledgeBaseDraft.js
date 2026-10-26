/**
 * Save and unsaved-change rules for the knowledge base editor
 * (pages/admin/KnowledgeBaseEditor.jsx).
 *
 * The editor auto-saves its conversation as a draft, but the classroom uses the
 * knowledge base only after the admin saves it. "Unsaved" therefore means
 * content the knowledge base does not include yet: conversation turns after the
 * last save, or a preview that differs from the saved knowledge base.
 */

/** Shorter extraction output is a failure, so it is never saved. */
export const MIN_KNOWLEDGE_BASE_LENGTH = 50;

/** Markdown that may be saved. The saved knowledge base can always be saved again. */
export function savableKnowledgeBase(markdown, savedMarkdown = '') {
  if (typeof markdown !== 'string' || !markdown) return false;
  return markdown.length >= MIN_KNOWLEDGE_BASE_LENGTH || markdown === savedMarkdown;
}

/**
 * How many leading messages the saved knowledge base already includes. Turns
 * auto-saved after the last save are stored with `unpublished: true`; drafts
 * stored before that flag existed count as fully saved.
 */
export function savedMessageCount(conversation) {
  if (!Array.isArray(conversation)) return 0;
  const index = conversation.findIndex(message => message?.unpublished === true);
  return index === -1 ? conversation.length : index;
}

/** The conversation to store. Turns from `savedThrough` on are flagged as unpublished. */
export function conversationForStorage(messages, savedThrough = messages.length) {
  return messages.map(({ role, content, msgType }, index) => (index < savedThrough
    ? { role, content, msgType }
    : { role, content, msgType, unpublished: true }));
}

/**
 * Derived editor state.
 * - previewCurrent: the preview includes every message, so it can be saved as is.
 * - saved: the preview is the saved knowledge base and nothing else is pending.
 * - dirty: turns or a preview that the saved knowledge base does not include.
 * - leaveGuard: why leaving needs confirmation: 'saving', 'unsaved', 'working' or null.
 */
export function knowledgeBaseEditorState({
  messageCount, savedMarkdown = '', savedThrough = 0, previewMarkdown = '', previewSyncedAt = 0,
  saving = false, working = false,
}) {
  const previewCurrent = !!previewMarkdown && messageCount <= previewSyncedAt;
  const dirty = messageCount > savedThrough || previewMarkdown !== savedMarkdown;
  return {
    previewCurrent,
    previewStale: !!previewMarkdown && !previewCurrent,
    saved: !!savedMarkdown && !dirty,
    dirty,
    leaveGuard: saving ? 'saving' : dirty ? 'unsaved' : working ? 'working' : null,
  };
}

/**
 * The Markdown to save. A current preview is what the admin reviewed, so it is
 * saved verbatim; only a missing or stale preview needs a new extraction.
 */
export async function knowledgeBaseMarkdownForSave({ previewMarkdown, previewCurrent, extract }) {
  if (previewCurrent) return { markdown: previewMarkdown, extracted: false };
  return { markdown: await extract(), extracted: true };
}

/**
 * Track draft requests that have already started. Publishing waits for all of
 * them to settle so an older draft cannot restore unpublished flags afterward.
 * A failed draft still permits a complete explicit save of the current state.
 */
export function createKnowledgeBaseWriteBarrier() {
  const pending = new Set();
  return {
    track(write) {
      const request = Promise.resolve(write);
      pending.add(request);
      request.then(() => pending.delete(request), () => pending.delete(request));
      return request;
    },
    async wait() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

// Shared across editor mounts: leaving and reopening must not forget a draft
// request that is still in flight from the previous visit.
export const knowledgeBaseDraftWrites = createKnowledgeBaseWriteBarrier();
