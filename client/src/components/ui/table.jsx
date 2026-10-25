"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({
  className,
  stickyFirstColumn = true,
  'aria-label': ariaLabel = 'Scrollable table',
  ...props
}) {
  return (
    <div
      data-slot="table-container"
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      className="relative w-full overflow-x-auto overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <table
        data-slot="table"
        className={cn(
          "w-full caption-bottom text-sm tabular-nums",
          stickyFirstColumn &&
            "[&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:z-10 [&_th:first-child]:bg-card [&_th:first-child]:max-w-[11rem] sm:[&_th:first-child]:max-w-none [&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-10 [&_td:first-child]:bg-card [&_td:first-child]:max-w-[11rem] sm:[&_td:first-child]:max-w-none [&_tr:hover_td:first-child]:bg-muted/50 [&_tbody_tr:hover_th:first-child]:bg-muted/50 [&_tr[data-state=selected]_td:first-child]:bg-muted [&_tbody_tr[data-state=selected]_th:first-child]:bg-muted [&_th:first-child]:border-r [&_th:first-child]:border-border/60 [&_td:first-child]:border-r [&_td:first-child]:border-border/60",
          className
        )}
        {...props} />
    </div>
  );
}

function TableHeader({
  className,
  ...props
}) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props} />
  );
}

function TableBody({
  className,
  ...props
}) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props} />
  );
}

function TableFooter({
  className,
  ...props
}) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props} />
  );
}

function TableRow({
  className,
  ...props
}) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props} />
  );
}

function TableHead({
  className,
  scope = "col",
  ...props
}) {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props} />
  );
}

function TableCell({
  className,
  as: Component = "td",
  ...props
}) {
  return (
    <Component
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props} />
  );
}

function TableCaption({
  className,
  ...props
}) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props} />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
