import { memo } from 'react';
import { renderMd } from '../../lib/helpers.js';

// Memoized: while a reply streams, the lesson page re-renders on every reveal
// tick, and past messages would otherwise re-parse their markdown each time.
export default memo(function AssistantMessage({ content, streaming = false, speakerLabel }) {
  let text = content;
  try {
    const parsed = JSON.parse(content);
    text = parsed.message || content;
  } catch { /* plain text */ }

  // While streaming, the partial text is hidden from screen readers
  // (`aria-hidden`) — so it must also be unfocusable and excluded from chat
  // keyboard nav, otherwise focus can land on an aria-hidden element (an
  // accessibility violation the browser blocks). Once persisted (not
  // streaming) it becomes a normal, navigable message.
  return (
    <div className="flex justify-start"
      data-chat-message={streaming ? undefined : 'assistant'}
      tabIndex={streaming ? undefined : -1}
      aria-hidden={streaming || undefined}
      inert={streaming || undefined}
    >
      {!speakerLabel && <span className="sr-only">Coach says: </span>}
      <div className="coach-copy min-w-0 max-w-[85%] px-1 py-2 text-base font-serif">
        {speakerLabel && <p className="mb-2 font-sans text-xs font-medium text-muted-foreground">{speakerLabel}</p>}
        <div dangerouslySetInnerHTML={{ __html: renderMd(text) }} />
      </div>
    </div>
  );
});
