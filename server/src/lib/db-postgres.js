import pg from 'pg';
import { setTimeout } from 'node:timers/promises';
import { createPostgresDatabase } from './postgres-database.js';

if ((!process.env.PGHOST && !process.env.INSTANCE_CONNECTION_NAME) || !process.env.PGDATABASE || !process.env.PGUSER || !process.env.PGPASSWORD) {
  throw new Error('PostgreSQL requires a host or Cloud SQL instance, database, user and password');
}

// The connector authenticates the instance and encrypts private-IP traffic.
// It uses Cloud Run's service identity; no service-account key is shipped.
let connector;
let connectionOptions = {};
if (process.env.INSTANCE_CONNECTION_NAME) {
  const { Connector, IpAddressTypes } = await import('@google-cloud/cloud-sql-connector');
  connector = new Connector();
  connectionOptions = await connector.getOptions({
    instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME,
    ipType: IpAddressTypes.PRIVATE,
  });
}
export const pool = new pg.Pool({
  ...connectionOptions,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});
pool.on('error', error => console.error(JSON.stringify({ event: 'postgres_connection_error', code: error.code })));

// Direct VPC routes can take time to become available during a cold start.
// Retry connection failures while the startup probe keeps traffic away; never
// fall back to an ephemeral database or swallow schema/permission errors.
let db;
for (let attempt = 0; ; attempt++) {
  try {
    db = await createPostgresDatabase(pool);
    break;
  } catch (error) {
    const connectionFailure = ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET'].includes(error.code)
      || error.message === 'Connection terminated due to connection timeout';
    if (!connectionFailure || attempt >= 5) throw error;
    console.warn(JSON.stringify({ event: 'postgres_connect_retry', attempt: attempt + 1, code: error.code }));
    await setTimeout(5000);
  }
}
export default db;

export async function closeDatabase() {
  await pool.end();
  connector?.close();
}
