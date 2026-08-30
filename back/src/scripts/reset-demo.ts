import 'dotenv/config';

import argon2 from 'argon2';

import { createDatabaseClient } from '../database/client.js';

const databaseUrl = process.env.DATABASE_URL;
const password = process.env.DEMO_ACCOUNT_PASSWORD;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!password || password.length < 12) throw new Error('DEMO_ACCOUNT_PASSWORD must be at least 12 characters');
const demoPassword = password;

const database = createDatabaseClient(databaseUrl);
const client = await database.pool.connect();
try {
  if (process.env.DEMO_RESET_IF_EMPTY === 'true') {
    const existing = await client.query<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM users) AS exists');
    if (existing.rows[0]?.exists) {
      process.stdout.write('Demo accounts already exist; startup reset skipped.\n');
      process.exitCode = 0;
    } else {
      await reset();
    }
  } else {
    await reset();
  }
} finally {
  client.release();
  await database.pool.end();
}

async function reset(): Promise<void> {
  const passwordHash = await argon2.hash(demoPassword, { type: argon2.argon2id });
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE users CASCADE');
    await client.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES
      ('30000000-0000-4000-8000-000000000001', 'marta@nextwave.demo', $1, 'Marta Pérez', 'HUMAN'),
      ('30000000-0000-4000-8000-000000000002', 'merchant@nextwave.demo', $1, 'VuelaYa Operator', 'MERCHANT_OPERATOR'),
      ('30000000-0000-4000-8000-000000000003', 'auditor@nextwave.demo', $1, 'Independent Auditor', 'AUDITOR')`, [passwordHash]);
    await client.query(`INSERT INTO agents (id, owner_user_id, name, status, current_key_id) VALUES
      ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
       'Marta purchasing agent', 'ACTIVE', 'demo-agent-key-1')`);
    await client.query('COMMIT');
    process.stdout.write('Demo state reset: 3 accounts, 1 purchasing agent, 0 prior purchases.\n');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
