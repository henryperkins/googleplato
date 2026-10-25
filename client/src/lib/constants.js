// Microlearning constraints — single source of truth for lesson limits.
// Prompts (client/prompts/*.md) reference these values as literal numbers;
// update them there too if you change these.
export const MAX_EXCHANGES = 11;
export const MIN_OBJECTIVES = 2;
export const MAX_OBJECTIVES = 4;

// Screenshot cap in encoded data URL characters. The server rejects the
// whole `screenshot:*` JSON record over 380 KiB (sync-limits.js), so the
// client caps the encoded string it sends, leaving ~10 KiB of headroom for
// userId, dataKey, timestamps and JSON punctuation. Base64 needs no escaping.
export const SCREENSHOT_MAX_DATA_URL_CHARS = 370 * 1024;

// Exchange-based duration estimate. 11 exchanges ≈ 20 min target.
// Used for derived duration metrics (admin dashboard) instead of wall-clock,
// which inflates from multi-session or abandoned-then-resumed lessons.
export const MINS_PER_EXCHANGE = 1.8;

export const VIEW_DEPTH = {
  '/onboarding': 0,
  '/lessons': 1,
  '/lessons/create': 2,
  '/lesson': 2,
  '/settings': 1,
};

export const LESSON_PHASES = {
  LESSON_INTRO: 'lesson_intro',
  LEARNING: 'learning',
  COMPLETED: 'completed',
};

export const MSG_TYPES = {
  GUIDE: 'guide',
  USER: 'user',
};
