// A tab-scoped recovery copy survives reloads and navigation without mixing
// users or competing tabs. Server revisions remain the source of truth.
export const lessonRecoveryKey = (userId, lessonId) => `plato_lesson_recovery:${userId}:${lessonId}`;

export function readLessonRecovery(storage, key) {
  try {
    const saved = JSON.parse(storage?.getItem(key) || 'null');
    return saved && Number.isSafeInteger(saved.version) && saved.snapshot
      && Array.isArray(saved.operations) ? saved : null;
  } catch { return null; }
}

export function canStartNewDraft(id, error) {
  const match = /^admin-(\d{13})$/.exec(id || '');
  const age = match ? Date.now() - Number(match[1]) : -1;
  return error?.status === 404 && age >= 0 && age < 5 * 60 * 1000;
}

const conflict = () => Object.assign(new Error('This lesson changed in another session. Load the saved lesson before continuing.'), { status: 409 });

/**
 * One writer for conversation, metadata and final markdown. Failed/unknown
 * writes retain their operation ID so retries never repeat AI generation.
 * UI snapshots include the reviewed preview and any reply awaiting recovery.
 */
export function createLessonSaveQueue({ write, storage, storageKey, version = 0, operationId, snapshot, recovery }) {
  let currentVersion = recovery?.version ?? version;
  let currentSnapshot = recovery?.snapshot ?? snapshot;
  const operations = recovery?.operations ? [...recovery.operations] : [];
  let error = null;
  let localError = false;
  let running = null;
  let paused = false;
  const listeners = new Set();
  if (operationId && operations[0]?.id === operationId) {
    operations.shift();
    currentVersion = version;
  }
  if (currentVersion !== version) error = conflict();

  const getState = () => ({
    snapshot: currentSnapshot, version: currentVersion, pending: operations.length,
    saving: !!running, error, localError,
  });
  const emit = () => { for (const listener of listeners) listener(getState()); };
  const persist = () => {
    // A newly mounted editor may already own a newer recovery copy at this key.
    if (paused) return;
    try {
      storage.setItem(storageKey, JSON.stringify({ version: currentVersion, snapshot: currentSnapshot, operations }));
      localError = false;
    } catch { localError = true; }
  };

  function flush() {
    if (running) return running;
    if (error?.status === 409) return Promise.reject(error);
    paused = false;
    error = null;
    // Defer the loop to ensure `running` is assigned before a synchronous error.
    running = Promise.resolve().then(async () => {
      while (operations.length && !paused) {
        const operation = operations[0];
        const saved = await write({ ...operation.body, operationId: operation.id, expectedVersion: currentVersion });
        if (!Number.isSafeInteger(saved?.version)) throw new Error('The save could not be confirmed. Retry saving.');
        currentVersion = saved.version;
        operations.shift();
        persist();
      }
    }).catch(failure => {
      error = failure;
      throw failure;
    }).finally(() => {
      running = null;
      emit();
    });
    emit();
    return running;
  }

  function enqueue(body) {
    operations.push({ id: crypto.randomUUID(), body: structuredClone(body) });
    persist();
    if (!error && !paused) void flush().catch(() => {});
    emit();
  }
  return {
    getState,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    remember(next) { currentSnapshot = structuredClone(next); persist(); emit(); },
    enqueue,
    async save(body) { enqueue(body); await flush(); },
    flush,
    discardRejected() {
      if (running || error?.status !== 400 || !operations[0]?.body.markdown) return false;
      operations.shift();
      error = null;
      persist();
      emit();
      return true;
    },
    pause() { paused = true; },
    clear() { if (!paused) { try { storage.removeItem(storageKey); } catch { /* Server has confirmed the save. */ } } },
  };
}
