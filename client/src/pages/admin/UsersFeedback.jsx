import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function UsersFeedback({ message, onDismiss }) {
  if (!message) return null;
  const error = message.type === 'error';
  return (
    <div
      className={`users-feedback flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${error ? 'border-danger-border bg-danger text-danger-foreground' : 'border-success-border bg-success text-success-foreground'}`}
      role={error ? 'alert' : 'status'}
    >
      {!error && <Check aria-hidden="true" className="users-result-icon mt-0.5 size-4 shrink-0" />}
      <p className="min-w-0 flex-1 self-center wrap-anywhere">{message.text}</p>
      {onDismiss && <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss notification"><X aria-hidden="true" /></Button>}
    </div>
  );
}
