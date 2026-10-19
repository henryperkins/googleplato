import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { lockBackgroundScroll, unlockBackgroundScroll } from '@/lib/scrollLock.js';

const AlertDialogContext = React.createContext(null);

function AlertDialog({ open = false, onOpenChange, children }) {
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

  return <AlertDialogContext.Provider value={ctx}>{children}</AlertDialogContext.Provider>;
}

function AlertDialogTrigger({ children, onClick, ...props }) {
  const ctx = React.useContext(AlertDialogContext);
  return (
    <button
      type="button"
      ref={ctx?.triggerRef}
      data-slot="alert-dialog-trigger"
      aria-haspopup="alertdialog"
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

function AlertDialogPortal({ children }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}

function AlertDialogOverlay({ className, ...props }) {
  return <div data-slot="alert-dialog-overlay" className={cn('hidden', className)} {...props} />;
}

function AlertDialogContent({ className, size = 'default', children, ...props }) {
  const ctx = React.useContext(AlertDialogContext);
  const dialogRef = React.useRef(null);
  const openerRef = React.useRef(null);

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

    // Move initial focus to the Cancel button (safe default for destructive confirmations)
    const cancelBtn = el.querySelector('[data-slot="alert-dialog-cancel"]');
    if (cancelBtn instanceof HTMLElement) {
      cancelBtn.focus();
    }

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
        const rect = openerRef.current.getBoundingClientRect?.();
        if (!rect || (rect.width > 0 && rect.height > 0)) {
          openerRef.current.focus();
        }
      }
    };
  }, [ctx?.open, ctx?.triggerRef]);

  if (!ctx?.open) return null;

  return (
    <AlertDialogPortal>
      <dialog
        ref={dialogRef}
        role="alertdialog"
        data-slot="alert-dialog-content"
        data-size={size}
        aria-labelledby={ctx.titleId}
        aria-describedby={ctx.descriptionId}
        onCancel={(e) => {
          e.preventDefault();
          ctx.requestClose();
        }}
        className={cn(
          'group/alert-dialog-content fixed top-1/2 left-1/2 z-50 m-0 flex w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto overscroll-contain rounded-xl bg-popover p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-popover-foreground ring-1 ring-foreground/10 outline-none backdrop:bg-black/35 backdrop:backdrop-blur-xs data-[size=default]:max-w-[min(22rem,calc(100%-2rem))] data-[size=sm]:max-w-[min(20rem,calc(100%-2rem))] data-[size=default]:sm:max-w-md',
          className
        )}
        {...props}
      >
        {children}
      </dialog>
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        'grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]',
        className
      )}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        '-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    />
  );
}

function AlertDialogMedia({ className, ...props }) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-10 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-6",
        className
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }) {
  const ctx = React.useContext(AlertDialogContext);
  return (
    <h2
      id={ctx?.titleId}
      data-slot="alert-dialog-title"
      className={cn(
        'font-heading text-base font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2',
        className
      )}
      {...props}
    />
  );
}

function AlertDialogDescription({ className, ...props }) {
  const ctx = React.useContext(AlertDialogContext);
  return (
    <p
      id={ctx?.descriptionId}
      data-slot="alert-dialog-description"
      className={cn(
        'text-sm text-balance text-muted-foreground md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}

function AlertDialogAction({ className, ...props }) {
  return <Button data-slot="alert-dialog-action" className={cn(className)} {...props} />;
}

function AlertDialogCancel({ className, variant = 'outline', size = 'default', onClick, ...props }) {
  const ctx = React.useContext(AlertDialogContext);
  return (
    <Button
      type="button"
      data-slot="alert-dialog-cancel"
      variant={variant}
      size={size}
      className={cn(className)}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) ctx?.requestClose();
      }}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
