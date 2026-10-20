import * as React from 'react';
import { cn } from '@/lib/utils';
import { ChevronRightIcon, CheckIcon } from 'lucide-react';
import { getPopoverPosition } from '@/lib/popoverPosition.js';

const DropdownMenuContext = React.createContext(null);

function DropdownMenu({ children }) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef(null);
  const popoverRef = React.useRef(null);
  const focusInsideOnCloseRef = React.useRef(false);
  const menuId = React.useId();

  const closeMenu = React.useCallback((restoreFocus = true) => {
    focusInsideOnCloseRef.current = restoreFocus;
    const pop = popoverRef.current;
    if (pop && typeof pop.hidePopover === 'function') {
      try {
        if (pop.matches(':popover-open')) {
          pop.hidePopover();
        }
      } catch {
        // ignore if already closed
      }
    }
    setOpen(false);
    if (restoreFocus && triggerRef.current && document.contains(triggerRef.current)) {
      triggerRef.current.focus();
    }
  }, []);

  const ctx = React.useMemo(
    () => ({ open, setOpen, triggerRef, popoverRef, focusInsideOnCloseRef, menuId, closeMenu }),
    [open, menuId, closeMenu]
  );

  return <DropdownMenuContext.Provider value={ctx}>{children}</DropdownMenuContext.Provider>;
}

function DropdownMenuPortal({ children }) {
  return <>{children}</>;
}

function DropdownMenuTrigger({ asChild = false, className, children, onClick, ...props }) {
  const ctx = React.useContext(DropdownMenuContext);

  const handleToggle = (e) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    const pop = ctx?.popoverRef.current;
    if (!pop) return;
    if (typeof pop.showPopover === 'function') {
      try {
        if (pop.matches(':popover-open')) {
          ctx.closeMenu(true);
        } else {
          pop.showPopover();
        }
      } catch {
        ctx.setOpen((prev) => !prev);
      }
    } else {
      ctx.setOpen((prev) => !prev);
    }
  };

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      ref: ctx?.triggerRef,
      'data-slot': 'dropdown-menu-trigger',
      'aria-haspopup': 'menu',
      'aria-expanded': !!ctx?.open,
      'aria-controls': ctx?.menuId,
      onClick: handleToggle,
      ...props,
    });
  }

  return (
    <button
      ref={ctx?.triggerRef}
      type="button"
      data-slot="dropdown-menu-trigger"
      aria-haspopup="menu"
      aria-expanded={!!ctx?.open}
      aria-controls={ctx?.menuId}
      onClick={handleToggle}
      className={className}
      {...props}
    >
      {children}
    </button>
  );
}

function DropdownMenuContent({
  align = 'start',
  sideOffset = 4,
  className,
  children,
  ...props
}) {
  const ctx = React.useContext(DropdownMenuContext);
  const [coords, setCoords] = React.useState({
    top: 8, left: 8, maxHeight: 'calc(100dvh - 16px)', maxWidth: 'calc(100vw - 16px)',
  });

  const updateCoords = React.useCallback(() => {
    const trig = ctx?.triggerRef.current;
    const pop = ctx?.popoverRef.current;
    if (!trig || !pop) return;
    if (typeof pop.showPopover === 'function' ? !pop.matches(':popover-open') : !ctx.open) return;
    const rect = trig.getBoundingClientRect();
    const visible = window.visualViewport;
    const next = getPopoverPosition({
      anchor: rect,
      menuWidth: pop.getBoundingClientRect().width,
      menuHeight: pop.scrollHeight + pop.offsetHeight - pop.clientHeight,
      viewport: {
        left: visible?.offsetLeft || 0,
        top: visible?.offsetTop || 0,
        width: visible?.width || window.innerWidth,
        height: visible?.height || window.innerHeight,
      },
      align,
      gap: sideOffset,
    });
    setCoords(previous => Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
  }, [ctx, align, sideOffset]);

  React.useEffect(() => {
    const pop = ctx?.popoverRef.current;
    if (!pop) return;

    const onBeforeToggle = (e) => {
      if (e.newState === 'closed') {
        // Track whether focus was inside the popover right before it closed.
        // If the user dismissed by clicking or tabbing to another control outside,
        // do not pull focus back to the trigger.
        ctx.focusInsideOnCloseRef.current = pop.contains(document.activeElement);
      }
    };

    const onToggle = (e) => {
      const isOpen = e.newState === 'open';
      ctx.setOpen(isOpen);
      if (isOpen) {
        updateCoords();
        requestAnimationFrame(() => {
          const firstItem = pop.querySelector('[role="menuitem"]:not([disabled])');
          firstItem?.focus();
        });
      } else if (ctx.focusInsideOnCloseRef.current) {
        ctx.triggerRef.current?.focus();
      }
    };

    pop.addEventListener('beforetoggle', onBeforeToggle);
    pop.addEventListener('toggle', onToggle);
    window.addEventListener('resize', updateCoords);
    window.addEventListener('scroll', updateCoords, true);
    window.visualViewport?.addEventListener('resize', updateCoords);
    window.visualViewport?.addEventListener('scroll', updateCoords);
    const observer = new ResizeObserver(updateCoords);
    observer.observe(pop);
    return () => {
      pop.removeEventListener('beforetoggle', onBeforeToggle);
      pop.removeEventListener('toggle', onToggle);
      window.removeEventListener('resize', updateCoords);
      window.removeEventListener('scroll', updateCoords, true);
      window.visualViewport?.removeEventListener('resize', updateCoords);
      window.visualViewport?.removeEventListener('scroll', updateCoords);
      observer.disconnect();
    };
  }, [ctx, updateCoords]);

  const handleKeyDown = (e) => {
    const pop = ctx?.popoverRef.current;
    if (!pop) return;
    const items = Array.from(pop.querySelectorAll('[role="menuitem"]:not([disabled])'));
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      ctx?.closeMenu(true);
    } else if (e.key === 'Tab') {
      // Allow Tab to move focus cleanly without yanking focus back
      ctx.focusInsideOnCloseRef.current = false;
      if (typeof pop.hidePopover === 'function' && pop.matches(':popover-open')) {
        pop.hidePopover();
      }
    }
  };

  return (
    <div
      ref={ctx?.popoverRef}
      id={ctx?.menuId}
      popover="auto"
      role="menu"
      data-slot="dropdown-menu-content"
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        inset: 'unset',
        ...coords,
        '--popover-available-width': typeof coords.maxWidth === 'number' ? `${coords.maxWidth}px` : coords.maxWidth,
      }}
      className={cn(
        'z-50 m-0 min-w-[min(11rem,var(--popover-available-width))] overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function DropdownMenuGroup({ ...props }) {
  return <div role="group" data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({ className, inset, ...props }) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        'px-2 py-1.5 text-xs font-medium text-muted-foreground break-all data-inset:pl-7',
        className
      )}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  onSelect,
  onClick,
  ...props
}) {
  const ctx = React.useContext(DropdownMenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      onClick={(e) => {
        onClick?.(e);
        // Close popover without restoring focus to trigger if onSelect opens another dialog/route
        ctx?.closeMenu(false);
        onSelect?.(e);
      }}
      className={cn(
        "group/dropdown-menu-item relative flex w-full min-h-11 md:min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:hover:bg-destructive/10 data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }) {
  return (
    <div
      role="separator"
      data-slot="dropdown-menu-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        'ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground',
        className
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({ className, children, checked, onSelect, ...props }) {
  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={checked}
      onSelect={onSelect}
      className={cn('pr-8', className)}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex items-center justify-center">
        {checked && <CheckIcon className="size-4" />}
      </span>
      {children}
    </DropdownMenuItem>
  );
}

function DropdownMenuRadioGroup({ children, ...props }) {
  return (
    <div role="group" data-slot="dropdown-menu-radio-group" {...props}>
      {children}
    </div>
  );
}

function DropdownMenuRadioItem({ className, children, checked, onSelect, ...props }) {
  return (
    <DropdownMenuItem
      role="menuitemradio"
      aria-checked={checked}
      onSelect={onSelect}
      className={cn('pr-8', className)}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex items-center justify-center">
        {checked && <CheckIcon className="size-4" />}
      </span>
      {children}
    </DropdownMenuItem>
  );
}

function DropdownMenuSub({ children }) {
  return <>{children}</>;
}

function DropdownMenuSubTrigger({ className, children, ...props }) {
  return (
    <DropdownMenuItem className={className} {...props}>
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuItem>
  );
}

function DropdownMenuSubContent({ children }) {
  return <>{children}</>;
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
