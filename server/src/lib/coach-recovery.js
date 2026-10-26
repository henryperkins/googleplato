import { deflateRawSync, inflateRawSync } from 'node:zlib';
import db from './db.js';
import { digest, verifyCoachTurn } from './coach-receipt.js';

const CHUNK_SIZE = 300000; // ASCII bytes, safely below DynamoDB's item limit.
export async function storeCoachResult(turn) {
  const key = `coachResult:${turn.lessonId}`;
  const previous = (await db.getSyncData(turn.userId, key, { consistentRead: true }))?.data;
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(turn))).toString('base64');
  const hash = digest(encoded);
  const chunks = [];
  for (let i = 0; i < encoded.length; i += CHUNK_SIZE) {
    const chunkKey = `${key}:${hash}:${chunks.length}`;
    await db.putSyncData(turn.userId, chunkKey, encoded.slice(i, i + CHUNK_SIZE));
    chunks.push(chunkKey);
  }
  // Publish only after all immutable fragments exist; readers validate both
  // the content digest and the original generated-turn receipt.
  await db.putSyncData(turn.userId, key, { format: 1, turnId: turn.turnId, hash, chunks });
  for (const oldKey of previous?.format === 1 ? previous.chunks : []) {
    if (!chunks.includes(oldKey)) await db.deleteSyncData(turn.userId, oldKey).catch(() => {});
  }
}
export async function readCoachResult(userId, lessonId) {
  const descriptor = (await db.getSyncData(userId, `coachResult:${lessonId}`, { consistentRead: true }))?.data;
  if (!descriptor) return null;
  if (descriptor.format !== 1) return null;
  if (!Array.isArray(descriptor.chunks) || descriptor.chunks.length > 10) return null;
  const values = await Promise.all(descriptor.chunks.map(key => db.getSyncData(userId, key, { consistentRead: true })));
  if (values.some(item => typeof item?.data !== 'string')) return null;
  const encoded = values.map(item => item.data).join('');
  if (digest(encoded) !== descriptor.hash) return null;
  try {
    const turn = JSON.parse(inflateRawSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 2000000 }).toString('utf8'));
    return turn.userId === userId && turn.lessonId === lessonId && verifyCoachTurn(turn) ? turn : null;
  } catch { return null; }
}
