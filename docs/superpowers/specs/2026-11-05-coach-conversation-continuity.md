# Coach conversation continuity

Approved scope: restore context in resumed legacy conversations, preserve the current assignment across reload/history limits, clarify ambiguous observations, qualify the behavior, release the fix, and repair the specifically reported thread without rewriting its transcript.

## Requirements
- Older assistant messages are bounded, explicitly unverified conversation context, never learner evidence, source identifiers, or completion authority.
- Preserve the original assignment verbatim (bounded to 6000 characters), including its URL and constraints, in a server-owned `conversationState` independent of assessment resets. Retain explicit learner task changes by reference to their exact saved/current text, not a model-authored replacement URL.
- Only a task change requested by the learner can update task directions. A question, a reference link, or a coach-generated URL cannot silently replace the assignment. Ambiguity calls for clarification.
- Preserve score/evidence/completed state, authentication, receipts, optimistic concurrency and inference-free save/replay.
- A scoped admin repair requires the exact current lesson snapshot and actual source message IDs; it leaves messages and assessment unchanged, removes only named existing misleading insights, replaces the mistaken learner-position summary with the actual observation, and supplies an explicit continuity correction for the next coach reply.
- A stale generated result or receipt cannot overwrite repaired state. No inferred mastery or new learner message is created by a repair.
- No new dependency or database schema; Node.js 20+, ES modules, single quotes, two spaces, semicolons.
- The dirty primary checkout is protected; implement on `fix/coach-conversation-continuity` based on freshly fetched `origin/main`.
- Verify exact old/new transcript assembly, long history, learner-requested changes, assessment safety, repair conflicts/authentication, and replay. Use a bounded live model evaluation with synthetic state, separately record editorial quality.
- Release only after passing checks and an approving review. Verify serving source identity before the backed-up production repair. The affected lesson's arbitrary target selection is reviewed and improved for future starts; do not silently change the established target of ongoing sessions.
