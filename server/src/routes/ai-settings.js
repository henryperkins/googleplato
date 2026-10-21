import { Hono } from 'hono';
import db from '../lib/db.js';
import ai from '../lib/ai-provider.js';
import { adminAiSettings, BEDROCK_MODEL, readAiSettings, validateAiSettings } from '../lib/ai-settings.js';
import { classifyAiError, aiErrorStatus } from '../lib/ai-errors.js';
import cloudflareOAuth from './cloudflare-oauth.js';

// Mounted inside admin.js after its authentication and admin middleware.
const settings = new Hono();
settings.route('/', cloudflareOAuth);
settings.use('/v1/admin/ai-settings', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

settings.get('/v1/admin/ai-settings', async (c) => {
  return c.json(await adminAiSettings(await readAiSettings(), c.get('userId')));
});

settings.put('/v1/admin/ai-settings', async (c) => {
  const body = await c.req.json();
  const error = validateAiSettings(body);
  if (error) return c.json({ error }, 400);
  if (!Number.isSafeInteger(body.version) || body.version < 0) return c.json({ error: 'Reload AI settings before saving.' }, 400);
  const current = await readAiSettings();
  const conflict = 'AI settings changed in another session. Reload settings before saving.';
  if (body.version !== current.version) return c.json({ error: conflict }, 409);
  const data = { provider: body.provider, workersAiModel: body.workersAiModel };
  try {
    const saved = await db.putSyncData('_system', 'ai-settings', data, current.version, { strictVersion: true });
    return c.json(await adminAiSettings({ ...data, version: saved.version }, c.get('userId')));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return c.json({ error: conflict }, 409);
    throw err;
  }
});

settings.post('/v1/admin/ai-settings/test', async (c) => {
  const body = await c.req.json();
  const error = validateAiSettings(body);
  if (error) return c.json({ error }, 400);
  try {
    const reply = await ai.invokeWithSettings(body, {
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with exactly: Connection OK' }],
    });
    if (!reply.content?.some(block => block.type === 'text' && block.text?.trim())) throw new Error('Empty AI test response.');
    return c.json({ ok: true, provider: body.provider, model: body.provider === 'workers-ai' ? body.workersAiModel : BEDROCK_MODEL });
  } catch (err) {
    const { code, message } = classifyAiError(err);
    return c.json({ ok: false, code, error: message }, aiErrorStatus(code));
  }
});

export default settings;
