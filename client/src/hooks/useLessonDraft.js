import { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import { lessonDrafts } from '../lib/lessonDrafts.js';

export function useLessonDraft(userId, lessonId) {
  const scope = JSON.stringify([userId, lessonId]);
  const [state, setState] = useState(() => ({ scope, draft: lessonDrafts.read(userId, lessonId) }));
  const readRetention = useCallback(() => lessonDrafts.retentionStatus(userId, lessonId), [userId, lessonId]);
  const retentionStatus = useSyncExternalStore(lessonDrafts.subscribe, readRetention, () => 'pending');
  // Never render or persist the previous account's state while effects catch up.
  const draft = useMemo(() => state.scope === scope ? state.draft : lessonDrafts.read(userId, lessonId), [state, scope, userId, lessonId]);
  const update = useCallback((field, value) => {
    setState(previous => {
      const current = previous.scope === scope ? previous.draft : lessonDrafts.read(userId, lessonId);
      return { scope, draft: { ...current, [field]: typeof value === 'function' ? value(current[field]) : value } };
    });
  }, [scope, userId, lessonId]);
  useEffect(() => {
    if (state.scope === scope) lessonDrafts.write(userId, lessonId, state.draft);
  }, [state, scope, userId, lessonId]);
  const retryRetention = useCallback(() => {
    return lessonDrafts.write(userId, lessonId, draft);
  }, [userId, lessonId, draft]);
  const setText = useCallback(value => update('text', value), [update]);
  const setImages = useCallback(value => update('images', value), [update]);
  const setLinks = useCallback(value => update('links', value), [update]);
  const restore = useCallback(value => {
    // Verify the full copy before removing a separate submission record.
    if (!lessonDrafts.write(userId, lessonId, value)) return false;
    setState({ scope, draft: value });
    return true;
  }, [scope, userId, lessonId]);
  return { draft, setText, setImages, setLinks, restore, retentionStatus, retryRetention };
}
