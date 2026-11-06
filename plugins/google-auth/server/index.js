/**
 * Google Sign-In plugin — Firebase ID-token verification only.
 * Account admission and plato sessions remain owned by core external-auth.
 */

import {
  Hono,
  db,
  createRemoteJWKSet,
  jwtVerify,
  completeExternalAuth,
} from '../../../src/lib/plugins/sdk.js';
import manifest from '../plugin.json' with { type: 'json' };

const PLUGIN_ID = 'google-auth';
const MAX_ID_TOKEN_LENGTH = 16384;
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

const DEFAULT_SETTINGS = Object.fromEntries(
  Object.entries(manifest.settingsSchema.properties)
    .filter(([, schema]) => Object.hasOwn(schema, 'default'))
    .map(([key, schema]) => [key, schema.default])
);

async function verify(idToken, projectId) {
  const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  return payload;
}

let tokenVerifier = verify;

/** Test injection seam, matching the former core auth route. */
export function setFirebaseTokenVerifier(verifier) {
  tokenVerifier = verifier || verify;
}

async function projectId() {
  const activation = await db.getSyncData('_system', 'plugins:activation', { consistentRead: true });
  const configured = activation?.data?.[PLUGIN_ID]?.settings?.projectId;
  return typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : DEFAULT_SETTINGS.projectId;
}

const routes = new Hono();

// Public while enabled; the host dispatcher returns 404 while disabled.
routes.post('/exchange', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.idToken !== 'string' || !body.idToken) {
    return c.json({ error: 'Firebase ID token is required' }, 400);
  }
  if (body.idToken.length > MAX_ID_TOKEN_LENGTH) {
    return c.json({ error: 'Firebase ID token is too large' }, 413);
  }

  let claims;
  try {
    claims = await tokenVerifier(body.idToken, await projectId());
  } catch {
    return c.json({ error: 'Invalid or expired Google sign-in token' }, 401);
  }

  const email = typeof claims.email === 'string' ? claims.email.toLowerCase().trim() : '';
  if (typeof claims.sub !== 'string' || !claims.sub
    || claims.firebase?.sign_in_provider !== 'google.com') {
    return c.json({ error: 'A Google sign-in token is required' }, 401);
  }
  if (!email || claims.email_verified !== true) {
    return c.json({ error: 'A verified Google email address is required' }, 400);
  }

  const result = await completeExternalAuth({
    provider: 'google',
    subject: claims.sub,
    email,
    emailVerified: true,
    name: typeof claims.name === 'string' ? claims.name : '',
  }, body);
  return c.json(result.body, result.status);
});

export default { routes };
