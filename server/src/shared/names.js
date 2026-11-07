/**
 * Name helpers shared by the server (lib/names.js) and the client's forms, so
 * both split an old single `name` the same way (#402). Pure; no imports.
 *
 * Splitting happens at the first whitespace: "Mary Ann Evans" becomes "Mary" /
 * "Ann Evans". Nothing is discarded, and a one-word name is a first name with
 * no last name.
 */

export const cleanName = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

export function joinName(firstName, lastName) {
  return [cleanName(firstName), cleanName(lastName)].filter(Boolean).join(' ');
}

/** `{ firstName, lastName, parts }` from a single full name. */
export function splitName(full) {
  const s = cleanName(full);
  if (!s) return { firstName: '', lastName: '', parts: 0 };
  const i = s.indexOf(' ');
  if (i < 0) return { firstName: s, lastName: '', parts: 1 };
  return { firstName: s.slice(0, i), lastName: s.slice(i + 1), parts: s.split(' ').length };
}

/**
 * The first and last name a form should start with, from a user record, a
 * saved draft, or a prefill. Ones from before first/last names carry only
 * `name`; it's split like the server splits it, so a form never puts a whole
 * name in the first-name field (saving that would store it as the person's
 * own entry, with no last name).
 */
export function formNameParts(source) {
  if (typeof source?.firstName === 'string' && source.firstName.trim()) {
    return { firstName: source.firstName, lastName: typeof source.lastName === 'string' ? source.lastName : '' };
  }
  const { firstName, lastName } = splitName(source?.name);
  return { firstName, lastName };
}
