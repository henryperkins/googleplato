import { Hono } from 'hono';
import { authenticate } from '../middleware/authenticate.js';
import { fetchUrlContent } from '../lib/link-extractor.js';
import { LinkError } from '../lib/url-guard.js';

const links = new Hono();

links.use('/v1/links/*', authenticate);

// Fetch a user-supplied URL server-side, extract its readable text, and return
// it so the client can attach it to a coach message (analogous to images).
// SSRF defense + size/time caps live in link-extractor.js / url-guard.js.
links.post('/v1/links/fetch', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body.' }, 400);
  }
  const url = body?.url;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return c.json({ error: 'A url is required.' }, 400);
  }

  try {
    const result = await fetchUrlContent(url.trim());
    return c.json(result);
  } catch (e) {
    if (e instanceof LinkError) {
      return c.json({ error: e.message, code: e.code }, e.status);
    }
    return c.json({ error: "Couldn't load that link." }, 502);
  }
});

export default links;
