import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { XIcon } from 'lucide-react';
import { lockBackgroundScroll, unlockBackgroundScroll } from '@/lib/scrollLock.js';

const DialogContext = React.createContext(null);

function Dialog({ open = false, onOpenChange, children }) {
  const triggerRef = React.useRef(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  const requestClose = React.useCallback(() => {
    onOpenChange?.(false);
  }, [onOpenChange]);

  const ctx = React.useMemo(
    () => ({ open, onOpenChange, requestClose, triggerRef, titleId, descriptionId }),
    [open, onOpenChange, requestClose, titleId, descriptionId]
  );

  return <DialogContext.Provider value={ctx}>{children}</DialogContext.Provider>;
}

function DialogTrigger({ children, onClick, ...props }) {
  const ctx = React.useContext(DialogContext);
  return (
    <button
      type="button"
      ref={ctx?.triggerRef}
      data-slot="dialog-trigger"
      aria-haspopup="dialog"
      aria-expanded={!!ctx?.open}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) ctx?.onOpenChange?.(true);
      }}
      {...props}
    >
      {children}
    </button>
  );
}

function DialogPortal({ children }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}

function DialogClose({ children, onClick, render, className, ...props }) {
  const ctx = React.useContext(DialogContext);
  const handleClick = (e) => {
    onClick?.(e);
    if (!e.defaultPrevented) ctx?.requestClose();
  };

  if (React.isValidElement(render)) {
    return React.cloneElement(render, {
      'data-slot': 'dialog-close',
      className: cn(render.props.className, className),
      onClick: handleClick,
      ...props,
      children: children ?? render.props.children,
    });
  }

  return (
    <button
      type="button"
      data-slot="dialog-close"
      className={className}
      onClick={handleClick}
      {...props}
    >
      {children}
    </button>
  );
}

function DialogOverlay({ className, ...props }) {
  return <div data-slot="dialog-overlay" className={cn('hidden', className)} {...props} />;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  variant = 'dialog', // 'dialog' | 'sheet'
  ...props
}) {
  const ctx = React.useContext(DialogContext);
  const dialogRef = React.useRef(null);
  const bodyScrollRef = React.useRef(null);
  const openerRef = React.useRef(null);
  const dragStateRef = React.useRef(null);
  const [dragOffset, setDragOffset] = React.useState(0);

  React.useEffect(() => {
    const el = dialogRef.current;
    if (!el || !ctx?.open) return;

    openerRef.current =
      ctx.triggerRef.current ||
      (document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null);

    if (!el.open && typeof el.showModal === 'function') {
      try {
        el.showModal();
      } catch {
        el.setAttribute('open', '');
      }
    }
    lockBackgroundScroll();

    return () => {
      const active = document.activeElement;
      const hadFocusInside =
        !active || active === document.body || el.contains(active) || active === el;
      if (el.open && typeof el.close === 'function') {
        try {
          el.close();
        } catch {
          el.removeAttribute('open');
        }
      }
      unlockBackgroundScroll();
      if (hadFocusInside && openerRef.current && document.contains(openerRef.current)) {
        // Only restore focus if the opener is still visible and focusable
        const rect = openerRef.current.getBoundingClientRect?.();
        if (!rect || (rect.width > 0 && rect.height > 0)) {
          openerRef.current.focus();
        }
      }
    };
  }, [ctx?.open, ctx?.triggerRef]);

  if (!ctx?.open) return null;

  const isSheet = variant === 'sheet';

  const onPointerDown = (e) => {
    if (!isSheet) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const fromHandle = e.target.closest('[data-slot="sheet-handle"]');
    const scroller = bodyScrollRef.current;
    const atTop = !scroller || scroller.scrollTop <= 0;
    // Only initiate drag from the handle, or when content is scrolled to top and not interacting with a form control
    const interactiveTarget = e.target.closest('input, textarea, select, button, a, [role="button"], [role="radio"], [role="checkbox"]');
    if (!fromHandle && (!atTop || interactiveTarget)) return;

    if (fromHandle) {
      fromHandle.setPointerCapture?.(e.pointerId);
    }
    dragStateRef.current = {
      startY: e.clientY,
      startTime: performance.now(),
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e) => {
    const state = dragStateRef.current;
    if (!state || e.pointerId !== state.pointerId) return;
    const dy = e.clientY - state.startY;
    if (dy > 4) {
      setDragOffset(dy);
    }
  };

  const onPointerEnd = (e) => {
    const state = dragStateRef.current;
    if (!state || e.pointerId !== state.pointerId) return;
    const dy = e.clientY - state.startY;
    const dt = Math.max(1, performance.now() - state.startTime);
    const velocity = dy / dt;
    dragStateRef.current = null;
    setDragOffset(0);

    if (e.type !== 'pointercancel' && (dy > 96 || (dy > 32 && velocity > 0.5))) {
      ctx.requestClose();
    }
  };

  return (
    <DialogPortal>
      <dialog
        ref={dialogRef}
        data-slot="dialog-content"
        data-variant={variant}
        aria-labelledby={props['aria-label'] ? undefined : ctx.titleId}
        aria-describedby={ctx.descriptionId}
        onCancel={(e) => {
          e.preventDefault();
          ctx.requestClose();
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current) {
            ctx.requestClose();
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        style={
          dragOffset > 0
            ? { transform: `translateY(${dragOffset}px)`, transition: 'none' }
            : undefined
        }
        className={cn(
          'fixed z-50 m-0 flex flex-col overflow-hidden bg-popover p-0 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none backdrop:bg-black/35 backdrop:backdrop-blur-xs',
          isSheet
            ? 'inset-x-0 bottom-0 top-auto w-full max-w-full max-h-[90dvh] rounded-t-2xl sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[calc(100%-2rem)] sm:max-w-lg sm:max-h-[calc(100dvh-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl'
            : 'top-1/2 left-1/2 w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl',
          className
        )}
        {...props}
      >
        {isSheet && (
          <div
            data-slot="sheet-handle"
            aria-hidden="true"
            className="flex shrink-0 justify-center pt-2.5 pb-1 sm:hidden cursor-grab active:cursor-grabbing select-none [touch-action:pan-x_pinch-zoom]"
          >
            <div className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
          </div>
        )}

        <div
          ref={bodyScrollRef}
          data-slot="dialog-body"
          className={cn(
            'flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain scroll-pb-24 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]',
            showCloseButton && '[&>[data-slot=dialog-header]]:pr-10'
          )}
        >
          {children}
        </div>

        {showCloseButton && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-slot="dialog-close"
            className="absolute top-2 right-2 z-10"
            onClick={() => ctx.requestClose()}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
        )}
      </dialog>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex shrink-0 flex-col gap-1.5', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, showCloseButton = false, children, ...props }) {
  const ctx = React.useContext(DialogContext);
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        '-mx-4 -mb-4 mt-auto flex shrink-0 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <Button type="button" variant="outline" onClick={() => ctx?.requestClose()}>
          Close
        </Button>
      )}
    </div>
  );
}

const DialogTitle = React.forwardRef(function DialogTitle({ className, ...props }, ref) {
  const ctx = React.useContext(DialogContext);
  return (
    <h2
      ref={ref}
      id={ctx?.titleId}
      data-slot="dialog-title"
      className={cn('font-heading text-base leading-none font-medium', className)}
      {...props}
    />
  );
});

function DialogDescription({ className, ...props }) {
  const ctx = React.useContext(DialogContext);
  return (
    <p
      id={ctx?.descriptionId}
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
