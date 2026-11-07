/**
 * Pure module-shape resolvers for plugin client exports. Kept in a separate file
 * from registry.js so unit tests can import them in plain Node without pulling
 * in loader.js (which uses Vite's `import.meta.glob`, undefined outside Vite).
 *
 * Plugins may export their client surface as either:
 *   export default { slots: { adminSettingsPanel: Panel } }   ← canonical
 *   export const slots = { adminSettingsPanel: Panel }        ← namespace
 * Both shapes are accepted.
 */

// Slots rendered only on public account pages (Login, Setup, Signup), which
// load their modules through PublicAuthProviders instead of this registry.
const PUBLIC_ONLY_SLOTS = new Set(['publicAuthProvider']);

/**
 * Whether signed-in pages need this plugin's client module. A plugin whose
 * declared slots are all public has nothing to render there, and skipping it
 * keeps provider SDKs (Firebase for Google sign-in) off admin pages. A plugin
 * that declares no slots still loads, for a top-level `settingsPanel` export.
 */
export function needsAuthenticatedClient(manifest) {
  const slots = Object.keys(manifest?.extensionPoints?.slots || {});
  return !(slots.length > 0 && slots.every((slot) => PUBLIC_ONLY_SLOTS.has(slot)));
}

/** Component for `slotName`, or null if the plugin doesn't register one. */
export function resolveSlotComponent(mod, slotName) {
  return mod?.default?.slots?.[slotName] || mod?.slots?.[slotName] || null;
}

/**
 * Settings panel for the admin plugin card on /plato/plugins. Resolution order:
 *   1. slots.adminSettingsPanel — canonical, matches every other slot
 *   2. settingsPanel            — convenience top-level export (back-compat)
 *
 * The Slack plugin uses (1). The fallback (2) keeps older plugin shapes working
 * if any exist.
 */
export function resolveSettingsPanel(mod) {
  return resolveSlotComponent(mod, 'adminSettingsPanel')
      || mod?.default?.settingsPanel
      || mod?.settingsPanel
      || null;
}
