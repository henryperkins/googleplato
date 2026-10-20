import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const SELECT_CLASS = 'h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base md:text-sm';

/**
 * One admin-defined custom user field (#364), rendered by type. Used on
 * Signup, /settings, ProfileCompletionGate, and the Admin → Edit User card.
 * Required fields show a visible "(required)" marker; it's aria-hidden
 * because aria-required already announces it (avoids "required, required").
 * `describedBy` links the control to a feedback or help element by id.
 * `readOnly` holds the value while a form saves without disabling the field,
 * which would drop focus to <body>. Native selects ignore `readonly`, so a
 * read-only dropdown keeps focus and simply ignores changes.
 */
export default function CustomFieldInput({
  field,
  value,
  onChange,
  onBlur,
  onKeyDown,
  enterKeyHint,
  inputRef,
  idPrefix = 'cf',
  disabled = false,
  readOnly = false,
  describedBy,
  error,
}) {
  const id = `${idPrefix}-${field.id}`;
  const errorId = `${id}-error`;
  const ariaDescribedBy = [error ? errorId : null, describedBy].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    ref: inputRef,
    value: value ?? '',
    disabled,
    'aria-required': field.required || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': ariaDescribedBy,
    onChange: (e) => { if (!readOnly) onChange(e.target.value); },
    onBlur,
    onKeyDown: field.type === 'textarea' ? undefined : onKeyDown,
  };

  let control;
  if (field.type === 'textarea') {
    control = <Textarea rows={3} enterKeyHint="enter" readOnly={readOnly} {...common} />;
  } else if (field.type === 'dropdown') {
    const options = field.options || [];
    control = (
      <select {...common} aria-readonly={readOnly || undefined} className={SELECT_CLASS}>
        <option value="">Select…</option>
        {/* Keep a value that's no longer an option visible rather than silently blanking it. */}
        {value && !options.includes(value) && <option value={value}>{value} (no longer an option)</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (field.type === 'link') {
    control = (
      <Input
        type="url"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="url"
        enterKeyHint={enterKeyHint}
        placeholder="https://"
        readOnly={readOnly}
        {...common}
      />
    );
  } else if (field.type === 'phone') {
    control = <Input type="tel" inputMode="tel" autoComplete="tel" enterKeyHint={enterKeyHint} readOnly={readOnly} {...common} />;
  } else {
    control = <Input type="text" enterKeyHint={enterKeyHint} readOnly={readOnly} {...common} />;
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required && <span className="text-muted-foreground text-xs" aria-hidden="true">(required)</span>}
      </Label>
      {control}
      {error && (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
