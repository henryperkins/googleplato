import { useEffect } from 'react';

/**
 * The message index Alt+Arrow moves to. `current` is -1 when focus is on the
 * log itself (or another control in it) rather than on a message: Alt+ArrowUp
 * then starts at the newest message, which is the one a learner returning to
 * the log after "New message from coach" wants, and Alt+ArrowDown starts at
 * the oldest. Movement stops at either end.
 */
export function nextMessageIndex(current, count, key) {
  if (count === 0) return -1;
  if (current === -1) return key === 'ArrowUp' ? count - 1 : 0;
  if (key === 'ArrowDown') return Math.min(current + 1, count - 1);
  return Math.max(current - 1, 0);
}

/**
 * Keyboard navigation for chat messages.
 *
 * When the chat log (or any descendant) is focused:
 *   Alt+ArrowDown → move focus to the next message
 *   Alt+ArrowUp   → move focus to the previous message
 *
 * @param {React.RefObject} logRef – ref to the chat log container element
 */
export function useChatKeyboardNav(logRef) {
  useEffect(() => {
    const log = logRef?.current;
    if (!log) return;

    function handleKeyDown(e) {
      if (!e.altKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      const msgs = Array.from(log.querySelectorAll('[data-chat-message]'));
      if (msgs.length === 0) return;

      e.preventDefault();

      const current = document.activeElement;
      // Find the currently-focused message (or its ancestor message)
      let idx = msgs.indexOf(current);
      if (idx === -1) {
        // activeElement might be a child of a message
        idx = msgs.findIndex(m => m.contains(current));
      }

      msgs[nextMessageIndex(idx, msgs.length, e.key)]?.focus();
    }

    log.addEventListener('keydown', handleKeyDown);
    return () => log.removeEventListener('keydown', handleKeyDown);
  }, [logRef]);
}
