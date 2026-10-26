const keyFor = (userId, kind) => `plato_settings_draft_v1:${encodeURIComponent(userId)}:${kind}`;
const legacyKeys = ['plato_settings_fields_draft', 'plato_profile_feedback_draft'];
const empty = kind => kind === 'fields' ? {} : '';

// Never assign an unowned legacy draft to the next person who signs in.
export function createSettingsDraftStore({ storage = () => sessionStorage } = {}) {
  const memory = new Map();
  const discardLegacy = () => {
    for (const key of legacyKeys) {
      try { storage().removeItem(key); } catch { /* Unread legacy data stays unused. */ }
    }
  };
  return {
    read(userId, kind) {
      discardLegacy();
      if (!userId) return empty(kind);
      const key = keyFor(userId, kind);
      if (memory.has(key)) return structuredClone(memory.get(key));
      try {
        const entry = JSON.parse(storage().getItem(key));
        if (entry?.userId !== userId || entry.kind !== kind) return empty(kind);
        if (kind === 'feedback' && typeof entry.value === 'string') return entry.value;
        if (kind === 'fields' && entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value)) {
          return Object.fromEntries(Object.entries(entry.value).filter(([, value]) => typeof value === 'string'));
        }
      } catch { /* Missing, corrupt or blocked storage supplies no draft. */ }
      return empty(kind);
    },
    write(userId, kind, value) {
      discardLegacy();
      if (!userId) return;
      memory.set(keyFor(userId, kind), structuredClone(value));
      try { storage().setItem(keyFor(userId, kind), JSON.stringify({ userId, kind, value })); } catch { /* Retain in this page session. */ }
    },
    clear(userId, kind, expected) {
      const current = this.read(userId, kind);
      if (expected !== undefined && (kind === 'feedback' ? current !== expected
        : Object.keys(current).length !== Object.keys(expected).length
          || Object.keys(current).some(key => current[key] !== expected[key]))) return false;
      this.write(userId, kind, empty(kind));
      return true;
    },
  };
}

// Only definitions returned for this learner may restore or submit values.
export function enabledSettingsValues(values, fields) {
  return Object.fromEntries(fields.filter(field => field.enabled !== false && field.disabled !== true)
    .map(field => [field.id, typeof values?.[field.id] === 'string' ? values[field.id] : '']));
}

export const settingsDrafts = createSettingsDraftStore();
