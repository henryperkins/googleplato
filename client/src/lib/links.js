import { authenticatedFetch } from '../../js/auth.js';

/**
 * Ask the server to fetch a URL and return its readable content. The server
 * handles SSRF guarding, size/time caps, and text extraction (see
 * server/src/routes/links.js). Throws an Error with a user-facing message on
 * failure.
 *
 * @param {string} url
 * @returns {Promise<{url, finalUrl, title, siteName, text, truncated}>}
 */
export async function fetchLinkContent(url) {
  let res;
  try {
    res = await authenticatedFetch('/v1/links/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch {
    throw new Error("Couldn't reach the server to load that link.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* leave null */ }
  if (!res.ok) {
    throw new Error(data?.error || "Couldn't load that link.");
  }
  return data;
}
