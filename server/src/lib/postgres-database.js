import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { REFRESH_TOKEN_TTL_DAYS, INVITE_TTL_DAYS, RESET_TOKEN_TTL_HOURS } from '../config.js';

function conflict(message) {
  return Object.assign(new Error(message), { name: 'ConditionalCheckFailedException' });
}

const now = () => new Date().toISOString();
const expiresIn = seconds => Math.floor(Date.now() / 1000) + seconds;
const syncColumns = 'user_id AS "userId", data_key AS "dataKey", data, version, updated_at AS "updatedAt"';

// Accept a pool so integration tests can exercise independent connections, just
// as separate Cloud Run instances do. No process-local state owns learner data.
export async function createPostgresDatabase(pool) {
  async function transaction(callback, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (userId !== undefined) {
        // All sync mutations share this lock, including inserts of absent keys
        // and resets. Row locks alone cannot protect a key that does not exist.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`plato:sync:${userId}`]);
      }
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('plato:schema:v1', 0))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, document JSONB NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (lower(document->>'email'));
      CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (lower(document->>'username'));
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, document JSONB NOT NULL);
      CREATE INDEX IF NOT EXISTS invites_email ON invites (lower(document->>'email'));
      CREATE TABLE IF NOT EXISTS refresh_tokens (id TEXT PRIMARY KEY, document JSONB NOT NULL);
      CREATE INDEX IF NOT EXISTS refresh_tokens_user ON refresh_tokens ((document->>'userId'));
      CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, document JSONB NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log ((document->>'userId'), (document->>'createdAt'));
      CREATE TABLE IF NOT EXISTS sync_data (
        user_id TEXT NOT NULL, data_key TEXT NOT NULL, data JSONB NOT NULL,
        version INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, data_key)
      );
    `);
    for (const table of ['invites', 'refresh_tokens']) {
      await client.query(`DELETE FROM ${table} WHERE (document->>'ttl')::bigint < $1`, [expiresIn(0)]);
    }
  });

  // Table names below are constants controlled by this module, never input.
  async function insert(table, id, document) {
    try {
      await pool.query(`INSERT INTO ${table} (id, document) VALUES ($1, $2::jsonb)`, [id, JSON.stringify(document)]);
    } catch (error) {
      if (error.code === '23505') throw conflict('Record already exists');
      throw error;
    }
  }
  async function one(table, condition, values, orderBy = '') {
    const result = await pool.query(`SELECT document FROM ${table} WHERE ${condition}${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT 1`, values);
    return result.rows[0]?.document ?? null;
  }
  async function many(table, condition = 'TRUE', values = [], orderBy = '') {
    return (await pool.query(`SELECT document FROM ${table} WHERE ${condition}${orderBy ? ` ORDER BY ${orderBy}` : ''}`, values)).rows.map(row => row.document);
  }
  async function patch(table, id, fields, condition = 'TRUE') {
    try {
      return await pool.query(`UPDATE ${table} SET document = document || $2::jsonb WHERE id = $1 AND ${condition}`, [id, JSON.stringify(fields)]);
    } catch (error) {
      if (error.code === '23505') throw conflict('Record already exists');
      throw error;
    }
  }
  async function remove(table, id) {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  }
  async function readLesson(client, userId, lessonId) {
    const keys = ['lessonGeneration', 'messages', 'lessonKB'].map(name => `${name}:${lessonId}`);
    // A single statement provides one consistent snapshot of all three keys.
    const { rows } = await client.query(`SELECT ${syncColumns} FROM sync_data WHERE user_id = $1 AND data_key = ANY($2::text[])`, [userId, keys]);
    const records = new Map(rows.map(row => [row.dataKey, row]));
    return {
      generation: records.get(keys[0])?.data ?? null,
      ...Object.fromEntries(['messages', 'lessonKB'].map((name, i) => {
        const row = records.get(keys[i + 1]);
        return [name, row ? { data: row.data, version: row.version } : { data: name === 'messages' ? [] : null, version: 0 }];
      })),
    };
  }
  async function writeSync(client, userId, dataKey, data, version) {
    const updatedAt = now();
    await client.query(`INSERT INTO sync_data (user_id, data_key, data, version, updated_at)
      VALUES ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT (user_id, data_key) DO UPDATE SET data = EXCLUDED.data,
        version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
    [userId, dataKey, JSON.stringify(data), version, updatedAt]);
    return { version, updatedAt };
  }

  return {
    async createUser({ userId, email, passwordHash, name, username, userGroup, role, slackUserId, customFields }) {
      const timestamp = now();
      await insert('users', userId, { userId, email: email.toLowerCase(), passwordHash, name,
        username: username || null, userGroup: userGroup || null, role, slackUserId: slackUserId || null,
        customFields: customFields || null, createdAt: timestamp, updatedAt: timestamp });
    },
    getUserById: userId => one('users', 'id = $1', [userId]),
    getUserByEmail: email => one('users', "lower(document->>'email') = $1", [email.toLowerCase()]),
    getUserByUsername: username => one('users', "lower(document->>'username') = $1", [username.toLowerCase()]),
    updateUser: (userId, fields) => patch('users', userId, { ...fields, userId, updatedAt: now() }),
    deleteUser: userId => remove('users', userId),
    async incrementUserCounter(userId, field, delta = 1) {
      if (field !== 'lessonsCompleted') throw new Error(`Unsupported counter field: ${field}`);
      await pool.query(`UPDATE users SET document = document || jsonb_build_object('lessonsCompleted',
        COALESCE((document->>'lessonsCompleted')::integer, 0) + $2::integer) WHERE id = $1`, [userId, delta]);
    },
    async setUserActivityField(userId, field, value) {
      if (!['lastActiveAt', 'lessonsCompleted'].includes(field)) throw new Error(`Unsupported activity field: ${field}`);
      await patch('users', userId, { [field]: value });
    },
    async removeUserCustomField(userId, fieldId) {
      await pool.query('UPDATE users SET document = document #- $2::text[] WHERE id = $1', [userId, ['customFields', fieldId]]);
    },
    listUsers: () => many('users', "document->>'role' = 'user'"),
    listAllUsers: () => many('users'),
    async countUsers() { return Number((await pool.query('SELECT count(*) FROM users')).rows[0].count); },

    createInvite: ({ inviteToken, email, invitedBy, slackUserId, isLink = false, usageCount = 0, maxUsages = null, profile = null }) =>
      insert('invites', inviteToken, { inviteToken, email: email?.toLowerCase() || null, invitedBy, slackUserId: slackUserId || null,
        isLink, usageCount, maxUsages, profile, status: 'pending', createdAt: now(), ttl: expiresIn(INVITE_TTL_DAYS * 86400) }),
    createWaitlistEntry: ({ inviteToken, email, profile }) => insert('invites', inviteToken,
      { inviteToken, email: email.toLowerCase(), profile, status: 'waitlist', createdAt: now() }),
    setInviteProfile: (token, profile) => patch('invites', token, { profile }),
    async updateWaitlistEntry(token, { email, profile }) {
      const result = await patch('invites', token, { email: email.toLowerCase(), profile }, "document->>'status' = 'waitlist'");
      if (result.rowCount !== 1) throw conflict('Not a wait-list entry');
    },
    getWaitlistEntryByEmail: email => one('invites', "lower(document->>'email') = $1 AND document->>'status' = 'waitlist'", [email.toLowerCase()]),
    getInviteByEmail: email => one('invites', "lower(document->>'email') = $1 AND document->>'status' = 'pending'", [email.toLowerCase()], "document->>'createdAt' DESC"),
    getInvite: token => one('invites', 'id = $1', [token]),
    markInviteUsed: token => patch('invites', token, { status: 'used', usedAt: now() }),
    deleteInvite: token => remove('invites', token),
    listInvites: () => many('invites'),
    getInviteLinkToken: () => one('invites', "document->>'isLink' = 'true' AND document->>'status' = 'pending'", []),
    async incrementLinkUsage(token) {
      const result = await pool.query(`UPDATE invites SET document = document || jsonb_build_object('usageCount',
        COALESCE((document->>'usageCount')::integer, 0) + 1) WHERE id = $1
        AND (document->>'maxUsages' IS NULL OR (document->>'usageCount')::integer < (document->>'maxUsages')::integer)`, [token]);
      if (result.rowCount !== 1) throw conflict('Invite missing or usage limit reached');
    },

    storeRefreshToken: (tokenHash, userId, credentialVersion = null) => insert('refresh_tokens', tokenHash, {
      tokenHash, userId, credentialVersion, type: 'refresh', createdAt: now(), ttl: expiresIn(REFRESH_TOKEN_TTL_DAYS * 86400),
    }),
    getRefreshToken: token => one('refresh_tokens', "id = $1 AND document->>'type' = 'refresh' AND (document->>'ttl')::bigint >= $2", [token, expiresIn(0)]),
    deleteRefreshToken: token => remove('refresh_tokens', token),
    storeResetToken: (tokenHash, userId) => insert('refresh_tokens', tokenHash, {
      tokenHash, userId, type: 'reset', createdAt: now(), ttl: expiresIn(RESET_TOKEN_TTL_HOURS * 3600),
    }),
    getResetToken: token => one('refresh_tokens', "id = $1 AND document->>'type' = 'reset' AND (document->>'ttl')::bigint >= $2", [token, expiresIn(0)]),
    deleteResetToken: token => remove('refresh_tokens', token),
    async consumeRefreshToken(token) {
      const result = await pool.query(
        `DELETE FROM refresh_tokens WHERE id = $1 AND document->>'type' = 'refresh' AND (document->>'ttl')::bigint >= $2 RETURNING document`,
        [token, expiresIn(0)]);
      return result.rows[0]?.document ?? null;
    },
    async consumeResetToken(token) {
      const result = await pool.query(
        `DELETE FROM refresh_tokens WHERE id = $1 AND document->>'type' = 'reset' AND (document->>'ttl')::bigint >= $2 RETURNING document`,
        [token, expiresIn(0)]);
      return result.rows[0]?.document ?? null;
    },
    async revokeUserTokens(userId) {
      await pool.query("DELETE FROM refresh_tokens WHERE document->>'userId' = $1", [userId]);
    },

    async getSyncData(userId, dataKey) {
      return (await pool.query(`SELECT ${syncColumns} FROM sync_data WHERE user_id = $1 AND data_key = $2`, [userId, dataKey])).rows[0] || null;
    },
    async getAllSyncData(userId, { excludePrefixes = [] } = {}) {
      // Filter in SQL with left() comparisons (never LIKE, whose %/_ would
      // stop being literal), so excluded rows are never detoasted or returned.
      const values = [userId, ...excludePrefixes];
      const excluded = excludePrefixes.length
        ? ` AND NOT (${excludePrefixes.map((_, i) => `left(data_key, length($${i + 2})) = $${i + 2}`).join(' OR ')})`
        : '';
      return (await pool.query(`SELECT ${syncColumns} FROM sync_data WHERE user_id = $1${excluded}`, values)).rows;
    },
    async getSyncDataByPrefixForAllUsers(prefix) {
      return (await pool.query(`SELECT ${syncColumns} FROM sync_data WHERE left(data_key, length($1)) = $1`, [prefix])).rows;
    },
    deleteAllSyncData(userId) {
      return transaction(async client => {
        const result = await client.query('DELETE FROM sync_data WHERE user_id = $1', [userId]);
        return result.rowCount;
      }, userId);
    },
    async getSyncDataByPrefix(userId, prefix) {
      return (await pool.query(`SELECT ${syncColumns} FROM sync_data WHERE user_id = $1 AND left(data_key, length($2)) = $2`, [userId, prefix])).rows;
    },
    putSyncData(userId, dataKey, data, expectedVersion, { strictVersion = false } = {}) {
      return transaction(async client => {
        const row = (await client.query('SELECT version FROM sync_data WHERE user_id = $1 AND data_key = $2', [userId, dataKey])).rows[0];
        if (strictVersion ? (expectedVersion === 0 ? !!row : !row || row.version !== expectedVersion)
          : expectedVersion && row && row.version !== expectedVersion) throw conflict('Version mismatch');
        return writeSync(client, userId, dataKey, data, (expectedVersion || 0) + 1);
      }, userId);
    },
    getLessonState: (userId, lessonId) => readLesson(pool, userId, lessonId),
    commitLessonTurn(userId, lessonId, base, desired) {
      return transaction(async client => {
        const current = await readLesson(client, userId, lessonId);
        if (current.generation !== base.generation) throw conflict('Lesson was reset');
        for (const name of ['messages', 'lessonKB']) {
          if (current[name].version !== base[name].version || !isDeepStrictEqual(current[name].data, base[name].data)) {
            throw conflict('Lesson changed while saving');
          }
        }
        const saved = { generation: base.generation };
        for (const name of ['messages', 'lessonKB']) {
          const version = base[name].version + 1;
          await writeSync(client, userId, `${name}:${lessonId}`, desired[name], version);
          saved[name] = { data: desired[name], version };
        }
        return saved;
      }, userId);
    },
    deleteSyncData(userId, dataKey, { invalidateLesson = false } = {}) {
      return transaction(async client => {
        const lessonId = invalidateLesson && /^(?:messages|lessonKB):(.+)$/.exec(dataKey)?.[1];
        if (lessonId) await writeSync(client, userId, `lessonGeneration:${lessonId}`, randomUUID(), 1);
        await client.query('DELETE FROM sync_data WHERE user_id = $1 AND data_key = $2', [userId, dataKey]);
      }, userId);
    },

    createAuditLog: ({ action, userId, email, performedBy, details }) => {
      const logId = `log_${randomUUID()}`;
      return insert('audit_log', logId, { logId, action, userId, email, performedBy, details: details || null, createdAt: now() });
    },
    listAuditLogsForUser: (userId, sinceIso) => many('audit_log',
      "document->>'userId' = $1 AND ($2::text IS NULL OR document->>'createdAt' >= $2)", [userId, sinceIso || null], "document->>'createdAt' DESC"),
  };
}
