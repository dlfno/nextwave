import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema.js';

export interface DatabaseClient {
  db: NodePgDatabase<typeof schema>;
  pool: Pool;
}

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  const pool = new Pool({ connectionString: databaseUrl });
  return { db: drizzle(pool, { schema }), pool };
}
