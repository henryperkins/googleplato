import { currentClientHeaders } from '../helpers/clientCompatibility.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import links, { LINK_FETCHES_PER_MINUTE, _resetLinkLimit } from '../../src/routes/links.js';
import db from '../../src/lib/db.js';
import { signAccessToken } from '../../src/lib/jwt.js';

it('limits each user to 20 link fetches a minute (upstream #516)', async () => {
  _resetLinkLimit();
  db.getUserById = async (userId) => ({ userId, role: 'learner' });
  const app = new Hono().route('/', links);
  const send = async (userId) => app.request('/v1/links/fetch', {
    method: 'POST',
    headers: { ...currentClientHeaders, 'Content-Type': 'application/json', Authorization: `Bearer ${await signAccessToken(userId, 'learner')}` },
    body: JSON.stringify({}), // no url: refused after the limit check, so nothing is fetched
  });
  for (let i = 0; i < LINK_FETCHES_PER_MINUTE; i++) assert.equal((await send('usr_a')).status, 400);
  const limited = await send('usr_a');
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'rate_limited');
  assert.equal((await send('usr_b')).status, 400, 'other users are untouched');
});
