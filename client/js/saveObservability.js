import { getImpersonation } from './auth.js';
import { getAuthUser, getAuthTokens } from './storage.js';

const MAX_EVENTS = 50;
const storageKey = userId => `plato_save_events:${encodeURIComponent(userId)}`;

// A bounded metadata-only outbox, independent of the generated-reply journal.
// Delivery is best effort: no timer retries, model calls, or save dependencies.
export function createSaveObserver({ storage = () => sessionStorage, getUser, send } = {}) {
  const states = new Map();
  const active = new Map();
  function stateFor(userId) {
    if (states.has(userId)) return states.get(userId);
    let state;
    try { state = JSON.parse(storage().getItem(storageKey(userId))); } catch { /* memory fallback */ }
    if (!Array.isArray(state?.events) || !Array.isArray(state?.incidents)) state = { events: [], incidents: [] };
    state.events = state.events.slice(-MAX_EVENTS);
    state.incidents = state.incidents.slice(-MAX_EVENTS);
    if (states.size >= 4) states.delete(states.keys().next().value);
    states.set(userId, state);
    return state;
  }
  function persist(userId, state) {
    try { storage().setItem(storageKey(userId), JSON.stringify(state)); } catch { /* saving is unaffected */ }
  }
  function flush(userId) {
    if (active.has(userId)) return active.get(userId);
    const task = (async () => {
      try {
        const state = stateFor(userId);
        while (state.events.length && await getUser() === userId) {
          const events = state.events.slice(0, 20);
          const response = await send({ userId, events });
          if (!response.ok) break;
          const delivered = new Set(events.map(event => event.eventId));
          state.events = state.events.filter(event => !delivered.has(event.eventId));
          persist(userId, state);
        }
      } catch { /* Keep the outbox for the next save, online event, or reload. */ }
    })().finally(() => active.delete(userId));
    active.set(userId, task);
    return task;
  }
  return {
    flush,
    record({ userId, operation, key, ok, reason = 'unconfirmed', status = 0 }) {
      try {
        if (!userId) return;
        const state = stateFor(userId);
        let incident = state.incidents.find(item => item.key === key && item.operation === operation);
        if (ok && !incident) { void flush(userId); return; }
        if (!incident) {
          incident = { key, operation, incidentId: crypto.randomUUID() };
          state.incidents.push(incident);
          state.incidents = state.incidents.slice(-MAX_EVENTS);
        }
        state.events.push({ code: ok ? 'client_save_recovered' : 'client_save_unconfirmed',
          eventId: crypto.randomUUID(), incidentId: incident.incidentId, operation,
          reason: ok ? 'confirmed' : reason, status });
        state.events = state.events.slice(-MAX_EVENTS);
        if (ok) state.incidents = state.incidents.filter(item => item !== incident);
        persist(userId, state);
        void flush(userId);
      } catch { /* Even unavailable storage/crypto cannot change a save outcome. */ }
    },
  };
}

export function saveFailureReason(error) {
  if (error?.code === 'client_upgrade_required') return 'upgrade_required';
  if (error?.code === 'invalid_ack') return 'invalid_ack';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  if (error?.status === 409) return 'conflict';
  if (error?.status >= 400) return 'rejected';
  if (error instanceof TypeError) return 'network';
  return 'unconfirmed';
}

const currentUser = async () => getImpersonation() ? null : (await getAuthUser())?.userId;
export const saveObserver = createSaveObserver({
  getUser: currentUser,
  async send(body) {
    // Telemetry must not rotate refresh tokens or notify session expiry. A 401
    // stays queued until normal application activity establishes valid auth.
    const tokens = await getAuthTokens();
    if (!tokens?.accessToken || tokens.user?.userId !== body.userId || getImpersonation()) return { ok: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await fetch(`${globalThis.__SERVICE_URL || ''}/v1/client-events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
        body: JSON.stringify(body), signal: controller.signal, keepalive: true,
      });
    } finally { clearTimeout(timer); }
  },
});
export function flushSaveEvents() {
  void currentUser().then(userId => userId && saveObserver.flush(userId)).catch(() => {});
}
if (typeof window !== 'undefined') window.addEventListener?.('online', flushSaveEvents);
