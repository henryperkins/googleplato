import { useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { MAX_EXCHANGES } from '../../lib/constants.js';

export default function MobileLessonRow({ lesson, courseName, stats, visibility, onEdit, onDelete }) {
  const actionsRef = useRef(null);
  const name = lesson.name || lesson.lessonId;
  const isDraft = lesson.status === 'draft';
  const average = stats?.avgExchanges;
  const overTarget = typeof average === 'number' && average > MAX_EXCHANGES;
  return (
    <li className="min-w-0 py-4">
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={onEdit}
          aria-label={`${isDraft ? 'Resume draft' : 'Edit'} ${name}`}
          className="touch-target min-w-0 flex-1 rounded-sm text-left text-base font-semibold leading-snug underline underline-offset-4 wrap-anywhere hover:text-link">
          {name}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="text-sm" aria-label={`Actions for ${name}`}
              onFocus={event => { actionsRef.current = event.currentTarget; }}
              onClick={event => { actionsRef.current = event.currentTarget; }}>
              Actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>{isDraft ? 'Resume draft' : 'Edit lesson'}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => {
              actionsRef.current?.focus();
              onDelete();
            }}>Delete lesson</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        {visibility}
        <span className="min-w-0 text-sm text-muted-foreground wrap-anywhere">{courseName || 'No course'}</span>
      </div>
      {lesson.updatedAt && <p className="mt-1 text-sm text-muted-foreground">Updated <time dateTime={lesson.updatedAt}>{new Date(lesson.updatedAt).toLocaleDateString()}</time></p>}
      <details className="group mt-1">
        <summary className="touch-target inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm text-sm font-medium hover:text-link [&::-webkit-details-marker]:hidden">
          Lesson metrics <span className="sr-only">for {name}</span>
          <ChevronDown className="size-4 group-open:rotate-180" aria-hidden="true" />
        </summary>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-2 text-sm">
          <dt className="text-muted-foreground">Completions</dt><dd className="tabular-nums">{stats?.completions ?? '—'}</dd>
          <dt className="text-muted-foreground">Average exchanges</dt><dd className={`tabular-nums ${overTarget ? 'text-warning-foreground' : ''}`}>{typeof average === 'number' ? average : '—'}</dd>
        </dl>
        {overTarget && <p className="pb-2 text-sm text-warning-foreground">Over the {MAX_EXCHANGES}-exchange target.</p>}
      </details>
    </li>
  );
}
