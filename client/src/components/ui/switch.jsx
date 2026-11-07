import { cn } from '@/lib/utils';

/**
 * Accessible on/off toggle (WAI-ARIA `switch`): a focusable button with
 * `role="switch"` and `aria-checked`; click and Space toggle. For a setting
 * that takes effect at once (activating a plugin, turning on an automatic
 * email), where a checkbox would suggest a form that saves later.
 *
 * Forced colors drop both fills, so the track keeps an outline and the knob
 * takes a system color, and the state stays visible.
 *
 * `busy` marks a change in progress: the switch keeps keyboard focus
 * (`aria-disabled`, not `disabled`), reports `aria-busy`, and ignores further
 * presses until the caller clears it.
 */
function Switch({ checked, onCheckedChange, disabled, busy = false, label, className, ...props }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => { if (!busy) onCheckedChange(!checked); }}
      className={cn(
        'touch-target inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-wait aria-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn(
        'pointer-events-none flex h-5 w-9 items-center rounded-full transition-colors forced-colors:outline forced-colors:outline-[color:CanvasText]',
        checked ? 'bg-primary forced-colors:bg-[color:Highlight]' : 'bg-input',
      )}>
        <span className={cn(
          'inline-block h-4 w-4 rounded-full bg-background shadow ring-0 transition-transform motion-reduce:transition-none',
          checked ? 'translate-x-[18px] forced-colors:bg-[color:HighlightText]' : 'translate-x-0.5 forced-colors:bg-[color:CanvasText]',
        )} />
      </span>
    </button>
  );
}

export { Switch };
