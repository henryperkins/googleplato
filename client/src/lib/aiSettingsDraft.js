const memoryDrafts = new Map();
const keyFor = userId => typeof userId === 'string' && userId ? `plato:ai-settings-draft:${encodeURIComponent(userId)}` : null;

function supportedDraft(value, settings) {
  return value && Number.isSafeInteger(value.version) && value.version >= 0
    && ['bedrock', 'workers-ai'].includes(value.provider)
    && Array.isArray(settings?.workersAiModels)
    && settings.workersAiModels.some(model => model.id === value.workersAiModel);
}

export function rememberAiSettingsDraft(storage, userId, settings, draft) {
  const key = keyFor(userId);
  const value = { version: settings?.version, provider: draft?.provider, workersAiModel: draft?.workersAiModel };
  if (!key || !supportedDraft(value, settings)) return false;
  const raw = JSON.stringify(value);
  memoryDrafts.set(key, raw);
  try {
    if (!storage) return false;
    storage.setItem(key, raw);
    return true;
  } catch { return false; }
}

export function clearAiSettingsDraft(storage, userId) {
  const key = keyFor(userId);
  if (!key) return;
  // A tombstone also prevents an inaccessible old storage entry from returning
  // if storage becomes available again after Save or an explicit discard.
  memoryDrafts.set(key, null);
  try { storage?.removeItem(key); } catch { /* The in-memory draft is already cleared. */ }
}

export function restoreAiSettingsDraft(storage, userId, settings) {
  const key = keyFor(userId);
  if (!key) return null;
  let raw;
  if (memoryDrafts.has(key)) raw = memoryDrafts.get(key);
  else {
    try { raw = storage?.getItem(key); } catch { return null; }
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!supportedDraft(value, settings)) {
      clearAiSettingsDraft(storage, userId);
      return null;
    }
    if (value.version !== settings.version) {
      clearAiSettingsDraft(storage, userId);
      return { changed: true };
    }
    return { draft: { provider: value.provider, workersAiModel: value.workersAiModel } };
  } catch {
    clearAiSettingsDraft(storage, userId);
    return null;
  }
}
