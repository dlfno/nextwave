import 'dotenv/config';

import pino from 'pino';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabaseClient } from './database/client.js';

const config = loadConfig();
const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    censor: '[REDACTED]',
  },
});
const database = createDatabaseClient(config.databaseUrl);
const app = createApp({ config, database, logger });

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Nextwave API listening');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');
  server.close(async () => {
    await database.pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
