import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export default function LessonVisibilityButton({ lesson, expanded, onOpen }) {
  const name = lesson.name || lesson.lessonId;
  if (lesson.status === 'draft') {
    return <Badge variant="outline" className="shrink-0 text-xs border-warning-border bg-warning text-warning-foreground">Draft</Badge>;
  }
  const isPublic = lesson.status === 'public';
  const recipientCount = lesson.sharedWith?.length || 0;
  const label = isPublic ? 'Public' : `Private${recipientCount
    ? ` (${recipientCount} ${recipientCount === 1 ? 'user' : 'users'})` : ''}`;
  return (
    <Button variant="outline" size="sm"
      className={`shrink-0 rounded-full ${isPublic ? '' : 'border-primary/30 bg-primary/10 text-primary-text'}`}
      aria-label={`Visibility and sharing for ${name}: ${label}`}
      aria-haspopup="dialog" aria-expanded={expanded}
      onClick={() => onOpen(lesson.lessonId, name, lesson.sharedWith, lesson.status)}>
      {label}
      <ChevronDown aria-hidden="true" />
    </Button>
  );
}
