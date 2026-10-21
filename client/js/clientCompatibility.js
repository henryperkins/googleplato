export const CLIENT_PROTOCOL = '1';
export const UPGRADE_MESSAGE = 'An update is required. Keep this page open until your reply and draft are ready to recover.';

export class ClientUpgradeError extends Error {
  constructor() {
    super(UPGRADE_MESSAGE);
    this.code = 'client_upgrade_required';
    this.status = 409;
  }
}

export function isCompatibilityPath(path) {
  return /^\/v1\/(sync|ai)(?:\/|\?|$)/.test(path) && !/^\/v1\/sync\/status(?:\?|$)/.test(path);
}

// Compatibility belongs to the loaded page, not the signed-in account.
// Logout and account switches must never upgrade old in-memory state.
export function createClientCompatibility() {
  let epoch = null;
  let blocked = false;
  let pending = null;
  const listeners = new Set();
  const requireClientUpgrade = () => {
    blocked = true;
    for (const listener of listeners) listener();
  };
  return {
    isClientUpgradeRequired: () => blocked,
    onClientUpgrade(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requireClientUpgrade,
    async compatibilityHeaders(loadStatus, { mutation = false } = {}) {
      if (blocked && mutation) throw new ClientUpgradeError();
      if (!epoch) {
        pending ||= (async () => {
          const status = await loadStatus();
          if (status?.protocol !== CLIENT_PROTOCOL || typeof status.epoch !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(status.epoch)) {
            requireClientUpgrade();
            throw new ClientUpgradeError();
          }
          epoch = status.epoch;
        })().finally(() => { pending = null; });
        await pending;
      }
      if (blocked && mutation) throw new ClientUpgradeError();
      // Recovery reads keep the original epoch. Only a fresh page negotiates
      // again, after preserving local work and rebuilding canonical state.
      return { 'X-Plato-Client-Protocol': CLIENT_PROTOCOL, 'X-Plato-Client-Epoch': epoch };
    },
  };
}

export const { isClientUpgradeRequired, onClientUpgrade, requireClientUpgrade, compatibilityHeaders } = createClientCompatibility();
