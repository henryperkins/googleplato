import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { renderMd } from '../../lib/helpers.js';

/**
 * Read-only markdown preview pane for the conversational admin editors (lesson
 * creator + knowledge base editor). Presentational only — all state is owned by
 * the parent view. The preview is refreshed manually (onRefresh runs the
 * relevant extractor agent); generated changes are persisted when the admin
 * clicks the parent's save button. The parent identifies already-saved content.
 *
 * Copy is parametrized so the same pane serves both editors; the defaults
 * preserve the original lesson-editor behavior.
 */
export default function MarkdownPreviewPane({
  markdown,
  loading,
  error,
  stale,
  saveLabel = 'Create Lesson',
  saved = false,
  saveHint = `Review this preview, then choose “${saveLabel}” to save it.`,
  onRefresh,
  refreshDisabled,
  title = 'Lesson preview',
  ariaLabel = 'Lesson markdown preview',
  noun = 'lesson',
  emptyHint = 'Describe the skill and what learners should be able to do in the conversation. Then generate a preview to review your lesson.',
}) {
  const hasContent = !!markdown?.trim();
  // Before the first extraction there is nothing to refresh — it's a generate.
  const refreshLabel = loading
    ? (hasContent ? 'Refreshing…' : 'Generating…')
    : (hasContent ? 'Refresh preview' : 'Generate preview');
  const showStaleHint = hasContent && stale && !loading;

  // Announce refresh start/finish to screen readers. Errors are announced by
  // the role="alert" region below, so the status region stays quiet on
  // failure to avoid a double announcement.
  const [announcement, setAnnouncement] = useState('');
  const wasLoading = useRef(loading);
  useEffect(() => {
    if (loading && !wasLoading.current) {
      setAnnouncement(hasContent ? `Refreshing ${noun} preview` : `Generating ${noun} preview`);
    } else if (!loading && wasLoading.current) {
      setAnnouncement(error ? '' : `${title} updated`);
    }
    wasLoading.current = loading;
  }, [loading, error, hasContent, noun, title]);

  return (
    <aside
      aria-label={ariaLabel}
      className="flex min-w-0 flex-col rounded-2xl bg-muted/40 border border-border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-9 max-w-full whitespace-normal py-2"
          onClick={onRefresh}
          disabled={refreshDisabled}
          focusableWhenDisabled
          aria-describedby={showStaleHint ? 'md-preview-stale-hint' : undefined}
        >
          {refreshLabel}
        </Button>
      </div>

      {/* Staleness hint — the conversation has advanced past the last refresh.
          Linked to the refresh button via aria-describedby so a screen-reader
          user hears why a refresh is worthwhile when the button is focused. */}
      {showStaleHint && (
        <p id="md-preview-stale-hint" className="text-sm text-muted-foreground mb-3">
          The conversation has changed. Refresh the preview to include your changes.
        </p>
      )}

      {hasContent && !stale && !loading && (
        <p
          role="note"
          className={saved
            ? 'text-sm text-muted-foreground mb-3'
            : 'text-sm rounded-md bg-warning text-warning-foreground px-3 py-2 mb-3'}
        >
          {saveHint}
        </p>
      )}

      {/* Screen-reader announcements for async refresh outcomes. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div className="flex-1 max-h-[70dvh] overflow-auto overscroll-contain" aria-busy={loading}>
        {error ? (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 text-destructive px-4 py-3 text-sm"
          >
            {error}
          </div>
        ) : loading ? (
          <div className="text-sm text-muted-foreground">{hasContent ? 'Refreshing preview…' : 'Generating preview…'}</div>
        ) : hasContent ? (
          <div
            className="coach-copy"
            dangerouslySetInnerHTML={{ __html: renderMd(markdown) }}
          />
        ) : (
          <div className="text-sm text-muted-foreground py-12 text-center">
            {emptyHint}
          </div>
        )}
      </div>
    </aside>
  );
}
