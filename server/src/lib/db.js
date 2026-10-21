/**
 * Database router — selects the explicitly configured persistent backend.
 */

const backend = process.env.DB_BACKEND || 'dynamodb';

let db;
if (backend === 'sqlite') {
  const mod = await import('./db-sqlite.js');
  db = mod.default;
} else if (backend === 'postgres') {
  const mod = await import('./db-postgres.js');
  db = mod.default;
} else if (backend === 'dynamodb') {
  const mod = await import('./db-dynamodb.js');
  db = mod.default;
} else {
  throw new Error(`Unsupported DB_BACKEND: ${backend}`);
}

export default db;
