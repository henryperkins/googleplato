import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import { activeFilterCount } from '../../lib/userFilters.js';
import { Button } from '@/components/ui/button';

const item = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent';

/**
 * The Admin → Users Filters menu (#362): one group of checkbox items per
 * facet (lib/userFilters.js), with Select all / Clear per facet. Checking
 * keeps the menu open. Non-modal, like the classroom menus (a modal Radix
 * menu aria-hides the page).
 */
export default function FiltersMenu({ facets, filters, onChange }) {
  const count = activeFilterCount(filters);
  const set = (key, values) => onChange({ ...filters, [key]: values });
  const keepOpen = (fn) => (e) => { e.preventDefault(); fn(); };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" aria-label={count ? `Filters, ${count} on` : 'Filters'}>
          Filters{count ? <span aria-hidden="true" className="ml-1 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{count}</span> : null}
        </Button>
      </DropdownMenuTrigger>

        <DropdownMenuContent align="start" sideOffset={4}
          className="z-50 max-h-[min(70dvh,32rem)] w-72 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          {facets.map((facet, fi) => {
            const checked = filters[facet.key] || [];
            return (
              <DropdownMenuGroup key={facet.key} aria-label={facet.label}>
                {fi > 0 && <DropdownMenuSeparator className="my-1 h-px bg-border" />}
                <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{facet.label}</DropdownMenuLabel>
                {facet.options.map((o) => (
                  <DropdownMenuCheckboxItem
                    key={o.value}
                    className={item}
                    checked={checked.includes(o.value)}
                    closeOnSelect={false}
                    onSelect={() => set(facet.key, checked.includes(o.value) ? checked.filter(v => v !== o.value) : [...checked, o.value])}
                  >
                    <span className="flex-1">{o.label}</span>
                    <span className="text-xs text-muted-foreground">{o.count}</span>
                  </DropdownMenuCheckboxItem>
                ))}
                <div className="flex gap-1 px-1 pb-1">
                  <DropdownMenuItem className={`${item} text-xs text-primary`} onSelect={keepOpen(() => set(facet.key, facet.options.map((o) => o.value)))}>
                    Select all<span className="sr-only"> {facet.label}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className={`${item} text-xs text-primary`} onSelect={keepOpen(() => set(facet.key, []))}>
                    Clear<span className="sr-only"> {facet.label}</span>
                  </DropdownMenuItem>
                </div>
              </DropdownMenuGroup>
            );
          })}
        </DropdownMenuContent>

    </DropdownMenu>
  );
}
