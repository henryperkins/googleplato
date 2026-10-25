/**
 * The Customizer's Styles draft: what GET /v1/admin/theme loads into the form,
 * and which fields Save sends. Kept free of React so it can be tested alone.
 */
import { DEFAULT_PRIMARY, normalizeHex } from './branding.js';

/** Reset stages the seeded maroon, a matching accent, no name and no logo. */
export const DEFAULT_STYLES = { primary: '#8b1a1a', accent: '#8b1a1a', matchPrimary: true, classroomName: '', logoBase64: null };

/** `#rgb` or `#rrggbb`, with or without the `#`, as lowercase `#rrggbb`; null otherwise. */
export function normalizeColor(value) {
  return /^#?(?:[\da-f]{3}|[\da-f]{6})$/i.test(value.trim()) ? normalizeHex(value) : null;
}

export function stylesFrom(data) {
  const primary = normalizeHex(data.theme?.primary) || DEFAULT_PRIMARY;
  const accent = normalizeHex(data.theme?.accent);
  return {
    primary,
    accent: accent || primary,
    // Earlier versions saved the accent even when it was the primary.
    matchPrimary: !accent || accent === primary,
    classroomName: typeof data.classroomName === 'string' ? data.classroomName.trim() : '',
    logoBase64: data.logoBase64 || null,
  };
}

/** The branding these styles publish: how the server would store them. */
export function publishedStyles(styles) {
  const color = value => normalizeColor(value) ?? value.trim().toLowerCase();
  const primary = color(styles.primary);
  const accent = styles.matchPrimary ? primary : color(styles.accent);
  return {
    // An accent equal to the primary is stored as Match primary.
    theme: { primary, ...(accent === primary ? {} : { accent }) },
    classroomName: styles.classroomName.trim(),
    logoBase64: styles.logoBase64,
  };
}

/**
 * The fields of `draft` that would publish something different from `saved`.
 * Empty when Save has nothing to do. Unchanged fields are left out, so a save
 * never resends the logo or overwrites what another admin changed elsewhere.
 */
export function changedStyles(draft, saved) {
  const next = publishedStyles(draft);
  const previous = publishedStyles(saved);
  const changes = Object.fromEntries(['classroomName', 'logoBase64']
    .filter(key => next[key] !== previous[key]).map(key => [key, next[key]]));
  // Null explicitly removes an independent accent. Omitting a color leaves the
  // latest server value alone, including edits from another administrator.
  const themePatch = Object.fromEntries(['primary', 'accent']
    .filter(key => next.theme[key] !== previous.theme[key]).map(key => [key, next.theme[key] ?? null]));
  if (Object.keys(themePatch).length) changes.themePatch = themePatch;
  return changes;
}
