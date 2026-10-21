import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  beginCloudflareOAuth, cloudflareOAuthCookieName, cloudflareReturnUrl, disconnectCloudflareOAuth,
  finishCloudflareOAuth, selectCloudflareAccount,
} from '../lib/cloudflare-oauth.js';

// Admin paths inherit authenticate/requireAdmin from admin.js. The callback is
// public because a browser redirect carries no Authorization header; its
// browser-bound, one-use transaction rechecks the initiating admin instead.
const oauth = new Hono();
async function oauthResponseHeaders(c, next) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  await next();
}
oauth.use('/v1/admin/ai-settings/cloudflare', oauthResponseHeaders);
oauth.use('/v1/admin/ai-settings/cloudflare/*', oauthResponseHeaders);
oauth.use('/v1/oauth/cloudflare/callback', oauthResponseHeaders);
const cookiePath = '/v1/oauth/cloudflare';

oauth.onError((error, c) => {
  const known = error.name === 'CloudflareOAuthError';
  return c.json({ error: known ? error.message : 'Cloudflare could not be connected. Try again.', code: known ? error.code : 'failed' }, known ? error.status : 500);
});

oauth.post('/v1/admin/ai-settings/cloudflare/connect', async c => {
  const { authorizationUrl, cookie, cookieName, secure } = await beginCloudflareOAuth(c.get('userId'));
  setCookie(c, cookieName, cookie, { httpOnly: true, secure, sameSite: 'Lax', path: cookiePath, maxAge: 600 });
  return c.json({ authorizationUrl });
});

oauth.get('/v1/oauth/cloudflare/callback', async c => {
  let result;
  let clearCookie = false;
  const cookieName = cloudflareOAuthCookieName(c.req.query('state'));
  try {
    result = await finishCloudflareOAuth({
      cookie: cookieName ? getCookie(c, cookieName) : undefined, state: c.req.query('state'),
      code: c.req.query('code'), error: c.req.query('error'),
    });
    clearCookie = true;
  } catch (error) {
    result = error.name === 'CloudflareOAuthError' ? error.code : 'failed';
    clearCookie = error.flowConsumed === true;
  }
  if (clearCookie && cookieName) deleteCookie(c, cookieName, { path: cookiePath });
  return c.redirect(cloudflareReturnUrl(result), 303);
});

oauth.post('/v1/admin/ai-settings/cloudflare/account', async c => {
  await selectCloudflareAccount(c.get('userId'), await c.req.json());
  return c.json({ ok: true });
});

oauth.delete('/v1/admin/ai-settings/cloudflare', async c => {
  const { version } = await c.req.json();
  return c.json({ ok: true, ...await disconnectCloudflareOAuth(version) });
});

export default oauth;
