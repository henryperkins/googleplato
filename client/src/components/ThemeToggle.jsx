import { Tooltip } from '@base-ui/react/tooltip';
import { Moon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTheme } from '../hooks/useTheme.js';

/**
 * Toggle between the light and dark themes (lib/theme.js). A toggle button
 * named "Dark mode": the name stays fixed while `aria-pressed` carries on/off,
 * and the moon fills in when dark mode is on. A tooltip shows the name on hover
 * and keyboard focus; screen readers already have it from the label, so the
 * tooltip doesn't describe the button. Colors come from the surrounding text
 * color, so it reads on any classroom header color and on the sign-in page.
 */
export default function ThemeToggle({ className }) {
  const [theme, toggleTheme] = useTheme();
  const dark = theme === 'dark';

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        type="button"
        delay={300}
        onClick={toggleTheme}
        aria-pressed={dark}
        aria-label="Dark mode"
        className={cn('touch-target flex shrink-0 items-center justify-center rounded-md border-none bg-transparent p-2 text-inherit cursor-pointer transition-colors hover:bg-current/10', className)}
      >
        <Moon aria-hidden="true" className="size-4" fill={dark ? 'currentColor' : 'none'} />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" sideOffset={6} className="z-50">
          <Tooltip.Popup className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-reduce:transition-none">
            Dark mode
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
