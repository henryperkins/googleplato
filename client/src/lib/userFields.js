// Client helpers for admin-defined custom user fields (#364). Validation is
// owned by the server (server/src/lib/user-fields.js); these helpers only
// drive form state, the ProfileCompletionGate, and Admin → Users search/filter.

export const FIELD_TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Text area' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'link', label: 'Link' },
  { value: 'phone', label: 'Phone' },
];

export function fieldTypeLabel(type) {
  return FIELD_TYPE_OPTIONS.find((t) => t.value === type)?.label || type;
}

const MAX_VALUE_LENGTH = { text: 200, textarea: 2000, dropdown: 100, link: 2000, phone: 30 };
const PHONE_RE = /^\+?[0-9 ().-]+$/;

/**
 * Validate a single custom user field value on blur or submit.
 * Returns an error string or '' when valid.
 */
export function validateCustomField(def, rawValue) {
  if (!def) return '';
  const val = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!val) {
    return def.required ? `${def.label} is required.` : '';
  }
  const maxLen = MAX_VALUE_LENGTH[def.type];
  if (maxLen && val.length > maxLen) {
    return `${def.label} must be ${maxLen} characters or fewer.`;
  }
  if (def.type === 'dropdown' && !(def.options || []).includes(val)) {
    return def.required ? `${def.label} is required.` : `${def.label} must be one of the listed options.`;
  }
  if (def.type === 'link') {
    let url;
    try { url = new URL(val); } catch { /* fallthrough */ }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return `${def.label} must be a valid http(s) link.`;
    }
  }
  if (def.type === 'phone') {
    const digits = val.replace(/\D/g, '').length;
    if (!PHONE_RE.test(val) || digits < 7 || digits > 15) {
      return `${def.label} must be a valid phone number.`;
    }
  }
  return '';
}

/**
 * Validate all custom fields and return an object mapping invalid field IDs to error messages.
 */
export function validateCustomFields(defs, values) {
  const v = values || {};
  const errors = {};
  for (const d of defs || []) {
    const err = validateCustomField(d, v[d.id]);
    if (err) errors[d.id] = err;
  }
  return errors;
}

/** Mirror of the server's missingRequiredFields — used to disable Save until filled. */
export function missingRequired(defs, values) {
  const v = values || {};
  return (defs || [])
    .filter((d) => d.required)
    .filter((d) => {
      const val = typeof v[d.id] === 'string' ? v[d.id].trim() : '';
      if (!val) return true;
      if (d.type === 'dropdown' && !(d.options || []).includes(val)) return true;
      return false;
    })
    .map((d) => d.id);
}

/** Only the values for the given field ids — what a partial PATCH should send. */
export function pickValues(values, ids) {
  const out = {};
  for (const id of ids) out[id] = values?.[id] ?? '';
  return out;
}

/** True when any custom field value contains the (lowercased) query. */
export function customFieldsMatch(customFields, q) {
  if (!customFields || !q) return false;
  return Object.values(customFields).some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
}

/**
 * Admin → Users field filter. `value` is matched exactly for dropdowns and as
 * a case-insensitive substring otherwise; the special values `__set` /
 * `__empty` filter on presence.
 */
export function matchesFieldFilter(customFields, def, value) {
  if (!def || !value) return true;
  const v = customFields?.[def.id];
  const has = typeof v === 'string' && v.trim() !== '';
  if (value === '__set') return has;
  if (value === '__empty') return !has;
  if (!has) return false;
  if (def.type === 'dropdown') return v === value;
  return v.toLowerCase().includes(value.trim().toLowerCase());
}
