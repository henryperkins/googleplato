/**
 * Teacher Comments — server side.
 *
 * A comment thread per user (multiple comments, each with timestamp and admin
 * attribution). Mounted at /v1/plugins/teacher-comments/. Admin-only.
 *
 * Storage: `userMeta:teacher-comments` per user holds { comments: [...] }.
 * Reads are tolerant of the prior single-comment shape ({ text, updatedAt,
 * updatedBy }) — converted to a one-item thread on the fly so no one loses
 * a note across the API change.
 */

import { randomBytes } from 'node:crypto';
import {
  Hono,
  db,
  authenticate,
  requireAdmin,
  getUserMeta,
  updateUserMeta,
  deleteUserMeta,
} from '../../../src/lib/plugins/sdk.js';

const PLUGIN_ID = 'teacher-comments';
const MAX_LEN = 4000;
const MAX_UPDATE_ATTEMPTS = 5;
const COMMENT_NOT_FOUND = 'COMMENT_NOT_FOUND';

const routes = new Hono();
routes.use('*', authenticate, requireAdmin);

function newId() {
  return 'cm_' + randomBytes(8).toString('hex');
}

/**
 * Normalize both the new array shape and the legacy single-comment shape into
 * `{ comments: [...] }` (newest first).
 */
function normalizeThread(meta) {
  if (!meta) return { comments: [] };
  if (Array.isArray(meta.comments)) {
    return { comments: [...meta.comments].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) };
  }
  // Legacy single-comment shape — surface it as a one-item thread.
  if (typeof meta.text === 'string' && meta.text.trim()) {
    return {
      comments: [{
        id: 'cm_legacy_' + (meta.updatedAt || Date.now()),
        text: meta.text,
        createdAt: meta.updatedAt || new Date().toISOString(),
        authorId: meta.updatedBy || null,
        authorName: null,
      }],
      legacy: true,
    };
  }
  return { comments: [] };
}

async function readThread(userId) {
  return normalizeThread(await getUserMeta(userId, PLUGIN_ID));
}

async function updateThread(userId, updater) {
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    try {
      return await updateUserMeta(userId, PLUGIN_ID, (meta) => updater(normalizeThread(meta)));
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException' || attempt === MAX_UPDATE_ATTEMPTS - 1) throw err;
    }
  }
}

function conflictResponse(c) {
  return c.json({ error: 'Comments changed concurrently. Retry.' }, 409);
}

// GET /admin/comments/:userId — full thread for a user.
routes.get('/admin/comments/:userId', async (c) => {
  const thread = await readThread(c.req.param('userId'));
  return c.json({ comments: thread.comments });
});

// POST /admin/comments/:userId — append a new comment. Body: { text: string }.
routes.post('/admin/comments/:userId', async (c) => {
  const userId = c.req.param('userId');
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'JSON body required' }, 400); }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ error: 'text (non-empty string) required' }, 400);
  if (text.length > MAX_LEN) return c.json({ error: `text must be ≤ ${MAX_LEN} chars` }, 400);

  const adminUser = c.get('user');
  const comment = {
    id: newId(),
    text,
    createdAt: new Date().toISOString(),
    authorId: adminUser.userId,
    authorName: adminUser.name || null,
  };

  try {
    await updateThread(userId, (existing) => ({ comments: [comment, ...existing.comments] }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return conflictResponse(c);
    throw err;
  }

  return c.json(comment, 201);
});

// DELETE /admin/comments/:userId/:commentId — delete a single comment.
routes.delete('/admin/comments/:userId/:commentId', async (c) => {
  const userId = c.req.param('userId');
  const commentId = c.req.param('commentId');
  try {
    await updateThread(userId, (existing) => {
      const next = existing.comments.filter((cm) => cm.id !== commentId);
      if (next.length === existing.comments.length) {
        const err = new Error('Comment not found');
        err.code = COMMENT_NOT_FOUND;
        throw err;
      }
      return { comments: next };
    });
  } catch (err) {
    if (err.code === COMMENT_NOT_FOUND) return c.json({ error: 'Comment not found' }, 404);
    if (err.name === 'ConditionalCheckFailedException') return conflictResponse(c);
    throw err;
  }
  return c.json({ ok: true });
});

export default {
  routes,
  async onActivate(ctx) {
    ctx.logger.info('activated');
  },
  /**
   * Wipe every comment thread for every user. Invoked from the admin UI's
   * "Delete plugin data" flow only after the admin has disabled the plugin
   * AND typed the plugin id to confirm. Errors propagate so the admin
   * sees a partial-deletion failure rather than a silent half-purge.
   */
  async onUninstall(ctx) {
    const users = await db.listAllUsers();
    let deleted = 0;
    for (const u of users) {
      const existing = await getUserMeta(u.userId, PLUGIN_ID);
      if (existing) {
        await deleteUserMeta(u.userId, PLUGIN_ID);
        deleted++;
      }
    }
    ctx.logger.info('data_uninstalled', { threadsRemoved: deleted });
  },
};
