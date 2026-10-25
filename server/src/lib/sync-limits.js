// Server cap for a single `screenshot:*` sync record, measured on the
// encoded JSON record as stored. DynamoDB caps an item at 400 KB; this
// stays under it. The client caps the encoded data URL at 370 KiB chars
// (client/src/lib/constants.js SCREENSHOT_MAX_DATA_URL_CHARS), leaving
// ~10 KiB for userId, dataKey, timestamps and JSON punctuation.
export const MAX_SCREENSHOT_RECORD_BYTES = 380 * 1024;
