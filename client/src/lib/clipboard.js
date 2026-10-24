/**
 * Clipboard writes that report whether they worked.
 *
 * `navigator.clipboard` is missing outside secure contexts, and its writes
 * reject when the browser or a permissions policy denies access, so a click
 * on a Copy button must not be assumed to have copied anything. Resolves
 * true only when the write resolved; never throws.
 */
export async function copyText(text, clipboard = globalThis.navigator?.clipboard) {
  if (typeof clipboard?.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
