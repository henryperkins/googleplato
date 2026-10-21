/**
 * Label for the generic plugin settings form (SettingsForm.jsx). Plugin
 * authors usually provide a custom settings panel; when they don't, field
 * labels come from the settings schema — a `title` when present, otherwise the
 * property key humanized so admins see "Bot token" instead of "botToken".
 */

/** camelCase / snake_case / kebab-case → "Bot token". */
export function humanizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

export function settingLabel(propKey, schema) {
  if (schema?.title) return schema.title;
  return humanizeKey(propKey);
}
