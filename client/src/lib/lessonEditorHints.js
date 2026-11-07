/** One recovery action for the composer's description and attempted-send status. */
export function lessonEditorComposerHint({ busy = '', saveState = {}, snapshot = {} } = {}) {
  const action = text => [text, text];
  if (saveState.error?.status === 409) return action('This lesson changed elsewhere. Choose “Load saved lesson”, then send.');
  if (saveState.error?.status === 400 && snapshot.finalizePending) return action('Choose “Revise lesson” in Preview, then send.');
  if (busy === 'starting' || busy === 'reply') return [];
  if (busy || saveState.saving) return action('Wait for saving to finish, then send.');
  if (saveState.error?.status === 400 && snapshot.visibilityPending) return action('Choose a visibility again in Visibility and sharing, then send.');
  if (saveState.error && (snapshot.visibilityPending || snapshot.finalizePending)) return action('Choose “Retry saving”, then send.');
  if (snapshot.finalizePending) return action('Choose “Retry saving lesson” in Preview, then send.');
  if (snapshot.visibilityPending) return action('Wait for saving to finish, then send.');
  if (snapshot.failedReply) return action('Choose “Retry reply”, then send.');
  return [];
}
