const draftKey = userId => `plato:cloudflare-draft:${userId}`;
const discardedDrafts = new Set();

export function clearCloudflareDraft(storage, userId) {
  if (!userId) return;
  discardedDrafts.add(userId);
  try { storage?.removeItem(draftKey(userId)); } catch { /* Keep the in-memory discard marker. */ }
}

export function rememberCloudflareDraft(storage, userId, settings, draft) {
  try {
    if (!storage || !userId) return false;
    storage.setItem(draftKey(userId), JSON.stringify({
      version: settings.version, provider: draft.provider, workersAiModel: draft.workersAiModel, createdAt: Date.now(),
    }));
    discardedDrafts.delete(userId);
    return true;
  } catch { return false; }
}

export function restoreCloudflareDraft(storage, userId, settings) {
  try {
    if (!storage || !userId) return null;
    if (discardedDrafts.has(userId)) {
      clearCloudflareDraft(storage, userId);
      return null;
    }
    const raw = storage.getItem(draftKey(userId));
    if (!raw) return null;
    storage.removeItem(draftKey(userId));
    const draft = JSON.parse(raw);
    if (!Number.isFinite(draft.createdAt) || Date.now() - draft.createdAt > 20 * 60_000
      || !['bedrock', 'workers-ai'].includes(draft.provider)
      || !settings.workersAiModels.some(item => item.id === draft.workersAiModel)) return null;
    if (draft.version !== settings.version) return { changed: true };
    return { draft: { provider: draft.provider, workersAiModel: draft.workersAiModel } };
  } catch { return null; }
}

export function cloudflareAuthorizationUrl(value) {
  const message = 'Cloudflare sign-in could not be opened. Try connecting again.';
  let url;
  try {
    if (typeof value !== 'string') throw new Error(message);
    url = new URL(value);
  } catch { throw new Error(message); }
  if (url.origin !== 'https://dash.cloudflare.com' || url.pathname !== '/oauth2/auth' || url.username || url.password) {
    throw new Error(message);
  }
  return url.href;
}

export function cloudflareReturnFeedback(result, oauth = {}) {
  if (result === 'connected') return oauth.connected
    ? { error: false, text: `Cloudflare connected${oauth.account?.name ? ` to ${oauth.account.name}` : ''}. Test the selected model, then save any pending AI settings.` }
    : { error: true, text: 'The Cloudflare connection could not be confirmed. Reload settings and try connecting again.' };
  if (result === 'select-account' && oauth.pendingAccounts?.length) return { error: false, text: 'Choose the Cloudflare account to use for this classroom.' };
  const messages = {
    denied: 'Cloudflare access was not approved. You can connect again when ready.',
    'invalid-state': 'This Cloudflare connection request expired or is no longer valid. Connect again from this page.',
    changed: 'The Cloudflare connection changed in another session. Reload settings before connecting again.',
    'setup-required': 'Browser connection has not been enabled on this server. Ask the server owner to complete Cloudflare OAuth setup.',
  };
  return { error: true, text: Object.hasOwn(messages, result) ? messages[result] : 'Cloudflare could not be connected. Try connecting again.' };
}
