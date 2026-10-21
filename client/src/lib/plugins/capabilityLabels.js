/**
 * Plain-language labels for plugin capabilities, shown on the admin Plugins
 * page. The raw capability tokens (docs/plugins/CAPABILITIES.md) are the
 * developer-facing contract; admins enabling a plugin need what a capability
 * authorizes, not its identifier. Unknown capabilities fall back to a
 * humanized form, and anything unrecognizable keeps its raw token so new
 * extension points stay visible instead of rendering blank.
 */

const STATIC_LABELS = {
  'server.routes': 'Add server API routes',
  'settings.read': 'Read its own settings',
  'settings.write': 'Update its own settings',
  'ui.adminNav': 'Add an admin navigation entry',
  'user.metadata.read': 'Read this plugin’s records for any user',
  'user.metadata.write': 'Create, change, or delete this plugin’s records for any user',
  'kpi': 'Contribute dashboard metrics',
  'agent': 'Provide AI agents',
  'syncData.namespace': 'Store per-user data',
  'lessonEnrichment': 'Add reference material when a lesson starts',
};

const HOOK_LABELS = {
  userCreated: 'Run when a user is created',
  userUpdated: 'Run when a user is updated',
  profileUpdated: 'Run when a learner profile is updated',
  lessonStarted: 'Run when a lesson starts',
  lessonCompleted: 'Run when a lesson is completed',
  coachExchangeRecorded: 'Run when a coach exchange is recorded',
};

const SLOT_LABELS = {
  adminSettingsPanel: 'Show a settings panel on the Plugins page',
  adminUserRowAction: 'Add an action to user rows',
  adminHomeKpi: 'Show a metric on the admin dashboard',
  adminProfileFields: 'Show a section on the Edit User page',
  learnerProfileFields: 'Show a field in the learner profile',
  learnerHomeBanner: 'Show a banner on the learner home',
};

// camelCase / snake_case / kebab-case -> "bot user token"
function humanize(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

export function capabilityLabel(capability) {
  if (typeof capability !== 'string' || !capability) return '';
  if (Object.hasOwn(STATIC_LABELS, capability)) return STATIC_LABELS[capability];
  const hook = /^hook\.([a-zA-Z][a-zA-Z0-9]*)$/.exec(capability);
  if (hook) {
    return Object.hasOwn(HOOK_LABELS, hook[1])
      ? HOOK_LABELS[hook[1]]
      : `Run on the ${humanize(hook[1])} event`;
  }
  const slot = /^ui\.slot\.([a-zA-Z][a-zA-Z0-9]*)$/.exec(capability);
  if (slot) {
    return Object.hasOwn(SLOT_LABELS, slot[1])
      ? SLOT_LABELS[slot[1]]
      : `Render in the ${humanize(slot[1])} area`;
  }
  return capability;
}
