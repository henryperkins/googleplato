/**
 * Auto-renders a settings form from a JSON Schema fragment. Supports primitives
 * (string, number, boolean, enum) and a single level of object nesting. For
 * anything more complex, plugins should provide an `adminSettingsPanel` slot.
 *
 * Used by AdminPlugins.jsx as a fallback when a plugin declares a
 * settingsSchema but does not register a custom settingsPanel.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { settingLabel } from '@/lib/plugins/settingLabels.js';

function fieldId(pluginId, key) {
  return `plugin-${pluginId}-${key}`;
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function descriptorFor(schema, key) {
  const descriptor = schema?.properties?.[key];
  return descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor) ? descriptor : {};
}

const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

export function effectivePluginSettings(schema, settings) {
  const effective = { ...(settings || {}) };
  for (const [key, descriptor] of Object.entries(schema?.properties || {})) {
    if (effective[key] === undefined && descriptor && Object.hasOwn(descriptor, 'default')) {
      effective[key] = descriptor.default;
    }
  }
  return effective;
}

export function settingsForSave(schema, draft) {
  const next = { ...(draft || {}) };
  for (const key of Object.keys(schema?.properties || {})) {
    if (typeof next[key] === 'string' && next[key].trim() === '') delete next[key];
  }
  return next;
}

export function settingsEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, index) => settingsEqual(value, b[index]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length
    && aKeys.every((key) => Object.hasOwn(b, key) && settingsEqual(a[key], b[key]));
}

// writeOnly values never come back from the server, which keeps a stored one
// when a save leaves it out. Once saved, a typed secret leaves the form.
export function withoutWriteOnly(schema, settings) {
  const next = { ...(settings || {}) };
  for (const key of Object.keys(schema?.properties || {})) {
    if (descriptorFor(schema, key).writeOnly) delete next[key];
  }
  return next;
}

/**
 * `storedWriteOnly` names the writeOnly settings the server holds. A required
 * one counts as set while its field is blank: saving keeps the stored value.
 */
export function validateRequiredSettings(schema, draft, storedWriteOnly = []) {
  const next = settingsForSave(schema, draft);
  const errors = {};
  for (const key of schema?.required || []) {
    const descriptor = descriptorFor(schema, key);
    if (descriptor.writeOnly && !Object.hasOwn(next, key) && storedWriteOnly.includes(key)) continue;
    const value = Object.hasOwn(next, key) ? next[key] : descriptor.default;
    if (isBlank(value)) errors[key] = `${settingLabel(key, descriptor)} is required.`;
  }
  return errors;
}

/** Fields left blank that saving returns to their declared default. */
export function defaultsRestoredBy(schema, draft) {
  return Object.keys(schema?.properties || {}).filter((key) => {
    const descriptor = descriptorFor(schema, key);
    return !descriptor.writeOnly && Object.hasOwn(descriptor, 'default')
      && typeof draft?.[key] === 'string' && draft[key].trim() === '';
  });
}

export function savedSettingsMessage(schema, restoredKeys = []) {
  if (restoredKeys.length === 0) return 'Settings saved.';
  const names = listFormat.format(restoredKeys.map((key) => settingLabel(key, descriptorFor(schema, key))));
  return restoredKeys.length === 1
    ? `Settings saved. ${names} was reset to its default.`
    : `Settings saved. ${names} were reset to their defaults.`;
}

// Answers what saving will do with this field when that isn't visible: keep a
// hidden secret, replace it, or put a cleared value back to its default.
export function settingHint(descriptor, value, stored) {
  if (descriptor.writeOnly) {
    if (!stored) return null;
    return isBlank(value) ? 'A value is saved. Leave this blank to keep it.' : 'Saving replaces the saved value.';
  }
  if (Object.hasOwn(descriptor, 'default') && typeof value === 'string' && value.trim() === '') {
    return 'Saving restores the default.';
  }
  return null;
}

function FieldMessages({ id, desc, hint, error }) {
  return (
    <>
      {desc && <p id={`${id}-description`} className="text-xs text-muted-foreground">{desc}</p>}
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>}
    </>
  );
}

function PrimitiveField({ pluginId, propKey, schema: descriptor, value, onChange, required, stored, error, saving }) {
  const schema = descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)
    ? descriptor : {};
  const id = fieldId(pluginId, propKey);
  // Schema title when the plugin provides one, otherwise a humanized key —
  // never the raw property name.
  const label = settingLabel(propKey, schema);
  const desc = schema.description;
  const hint = schema.type === 'boolean' ? null : settingHint(schema, value, stored);
  const describedBy = [desc && `${id}-description`, hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  const labelContent = <>{label}{required && <span className="text-muted-foreground"> (required)</span>}</>;
  const stateProps = {
    'aria-describedby': describedBy,
    'aria-required': required || undefined,
    'aria-invalid': !!error || undefined,
  };

  if (schema.type === 'boolean') {
    return (
      <div className="py-2">
        <div className="flex flex-wrap items-center gap-3">
          <input
            id={id}
            type="checkbox"
            checked={!!value}
            onChange={(e) => { if (!saving) onChange(e.target.checked); }}
            aria-disabled={saving || undefined}
            {...stateProps}
            className="size-4 shrink-0 rounded border-input accent-primary"
          />
          <Label htmlFor={id} className="touch-target flex items-center cursor-pointer select-none">{labelContent}</Label>
          {desc && <span id={`${id}-description`} className="text-xs text-muted-foreground basis-full sm:basis-auto">{desc}</span>}
        </div>
        {error && <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  if (Array.isArray(schema.enum)) {
    return (
      <div className="space-y-1 py-2">
        <Label htmlFor={id}>{labelContent}</Label>
        <select
          id={id}
          value={value ?? ''}
          onChange={(e) => { if (!saving) onChange(e.target.value); }}
          aria-disabled={saving || undefined}
          {...stateProps}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm"
        >
          {schema.enum.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        <FieldMessages id={id} desc={desc} hint={hint} error={error} />
      </div>
    );
  }

  if (schema.type === 'number') {
    return (
      <div className="space-y-1 py-2">
        <Label htmlFor={id}>{labelContent}</Label>
        <Input
          id={id}
          type="number"
          value={value ?? ''}
          min={schema.minimum}
          max={schema.maximum}
          readOnly={saving}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          {...stateProps}
        />
        <FieldMessages id={id} desc={desc} hint={hint} error={error} />
      </div>
    );
  }

  // Default: string. writeOnly fields use type=password to discourage
  // shoulder-surfing, and opt out of autofill so a browser never offers the
  // admin's own sign-in password as a plugin secret.
  return (
    <div className="space-y-1 py-2">
      <Label htmlFor={id}>{labelContent}</Label>
      <Input
        id={id}
        type={schema.writeOnly ? 'password' : 'text'}
        autoComplete={schema.writeOnly ? 'off' : undefined}
        value={value ?? ''}
        readOnly={saving}
        onChange={(e) => onChange(e.target.value)}
        {...stateProps}
      />
      <FieldMessages id={id} desc={desc} hint={hint} error={error} />
    </div>
  );
}

export default function SettingsForm({ pluginId, pluginName = 'Plugin', schema, settings, storedWriteOnly = [], onSave }) {
  const savedSettings = useMemo(() => effectivePluginSettings(schema, settings), [schema, settings]);
  const [draft, setDraft] = useState(savedSettings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [errors, setErrors] = useState({});
  const previousSaved = useRef({ pluginId, settings: savedSettings });
  const savedHere = useRef(false);
  // Compare what a save would send, so a secret typed and then erased (which
  // saving leaves out) isn't an unsaved change.
  const dirty = !settingsEqual(settingsForSave(schema, draft), settingsForSave(schema, savedSettings));

  // Reset the draft only when the saved values themselves change, so an
  // unrelated update on the page keeps unsaved edits. A save from this form
  // keeps its own result message.
  useEffect(() => {
    const fromSave = savedHere.current;
    savedHere.current = false;
    const previous = previousSaved.current;
    if (previous.pluginId === pluginId && settingsEqual(previous.settings, savedSettings)) return;
    previousSaved.current = { pluginId, settings: savedSettings };
    setDraft(savedSettings);
    setErrors({});
    if (!fromSave) setMessage(null);
  }, [pluginId, savedSettings]);

  if (!schema || schema.type !== 'object' || !schema.properties) {
    return (
      <p className="text-sm text-muted-foreground">
        This plugin has no configurable settings.
      </p>
    );
  }

  function changeField(propKey, value) {
    setDraft((current) => ({ ...current, [propKey]: value }));
    setMessage(null);
    setErrors((current) => {
      if (!current[propKey]) return current;
      const next = { ...current };
      delete next[propKey];
      return next;
    });
  }

  async function handleSave() {
    if (saving) return;
    const nextErrors = validateRequiredSettings(schema, draft, storedWriteOnly);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setMessage({ type: 'error', text: 'Complete the required fields.' });
      document.getElementById(fieldId(pluginId, Object.keys(nextErrors)[0]))?.focus();
      return;
    }

    setSaving(true);
    setMessage(null);
    setErrors({});
    try {
      const next = settingsForSave(schema, draft);
      const restored = defaultsRestoredBy(schema, draft);
      await onSave(next);
      savedHere.current = true;
      setDraft(effectivePluginSettings(schema, withoutWriteOnly(schema, next)));
      setMessage({ type: 'success', text: savedSettingsMessage(schema, restored) });
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Settings couldn’t be saved. Try again.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      {Object.entries(schema.properties).map(([propKey, propSchema]) => (
        <PrimitiveField
          key={propKey}
          pluginId={pluginId}
          propKey={propKey}
          schema={propSchema}
          value={draft[propKey]}
          onChange={(value) => changeField(propKey, value)}
          required={schema.required?.includes(propKey)}
          stored={storedWriteOnly.includes(propKey)}
          error={errors[propKey]}
          saving={saving}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        {/* Stays focusable when there is nothing to save, so a finished save
            never drops focus. The name says which plugin it saves. */}
        <Button
          onClick={handleSave}
          disabled={saving || !dirty}
          focusableWhenDisabled
          aria-label={`${saving ? 'Saving' : 'Save'} ${pluginName} settings`}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {dirty && !saving && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
        <span
          role="status"
          aria-live="polite"
          className={`text-sm ${message?.type === 'error' ? 'text-destructive' : 'text-success-foreground'}`}
        >
          {message?.text || ''}
        </span>
      </div>
    </div>
  );
}
