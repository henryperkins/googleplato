import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * First and last name inputs (#402), shared by signup, setup, the wait list,
 * Settings, and the admin user and wait-list editors. `value` is
 * `{ firstName, lastName }`; `onChange` gets the next object. A last name is
 * optional (people with one name exist).
 *
 * `inferred` (the record's `nameSource === 'auto'`) shows a hint that the
 * split was guessed from an older single name, tied to both inputs with
 * aria-describedby.
 */
export default function NameFields({ idPrefix, value, onChange, disabled = false, inferred = false, firstNameRef, lastNameRef, nextRef, errors = {}, onBlur }) {
  const hintId = `${idPrefix}-name-hint`;
  const describedBy = inferred ? hintId : undefined;
  const next = (event, target) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); target?.current?.focus(); } };
  const set = (key) => (e) => onChange({ ...value, [key]: e.target.value });
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-first-name`}>First name</Label>
          <Input
            id={`${idPrefix}-first-name`}
            ref={firstNameRef}
            enterKeyHint="next"
            onKeyDown={event => next(event, lastNameRef)}
            onBlur={() => onBlur?.('firstName')}
            aria-invalid={errors.firstName ? true : undefined}
            type="text"
            autoComplete="given-name"
            aria-required="true"
            aria-describedby={[describedBy, errors.firstName && `${idPrefix}-first-name-error`].filter(Boolean).join(' ') || undefined}
            disabled={disabled}
            value={value.firstName}
            onChange={set('firstName')}
          />
          {errors.firstName && <p id={`${idPrefix}-first-name-error`} className="text-xs text-destructive" role="alert">{errors.firstName}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-last-name`}>
            Last name <span className="text-muted-foreground text-xs">(optional)</span>
          </Label>
          <Input
            id={`${idPrefix}-last-name`}
            ref={lastNameRef}
            enterKeyHint="next"
            onKeyDown={event => next(event, nextRef)}
            type="text"
            autoComplete="family-name"
            aria-describedby={describedBy}
            disabled={disabled}
            value={value.lastName}
            onChange={set('lastName')}
          />
        </div>
      </div>
      {inferred && (
        <p id={hintId} className="text-xs text-muted-foreground">
          Split automatically from a single name. Check that it&rsquo;s right.
        </p>
      )}
    </div>
  );
}

