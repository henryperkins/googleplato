import { memo } from 'react';

// Memoized so streaming a reply doesn't re-render the learner's past messages.
export default memo(function UserMessage({ content, label }) {
  return (
    <div className="flex justify-end"
      data-chat-message="user" tabIndex={-1}
    >
      <span className="sr-only">You said: </span>
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-base text-primary-foreground font-sans break-words overflow-hidden">
        {/* pre-wrap keeps the learner's own line breaks and lists: plain Enter
            inserts a newline in the composer, and drafts are often multi-line. */}
        <p className="whitespace-pre-wrap">{label && <strong>{label}: </strong>}{content}</p>
      </div>
    </div>
  );
});
