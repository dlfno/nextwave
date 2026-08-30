import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { DatabaseClient } from '../src/database/client.js';
import type { CommerceProvider } from '../src/modules/commerce/index.js';
import type { MandateSigner } from '../src/modules/mandates/mandate-signer.js';

const config: AppConfig = { port: 3000, databaseUrl: 'postgresql://unused', frontendOrigin: 'http://localhost:4200', sessionTtlHours: 12, cookieSecure: false, nodeEnv: 'test' };
const database = { pool: { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) } } as unknown as DatabaseClient;

describe('readiness', () => {
  it('reports unavailable security and commerce surfaces', async () => {
    const response = await request(createApp({ config, database, logger: pino({ level: 'silent' }) })).get('/ready');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'not_ready', checks: { database: true, mandateSigner: false, commerce: false } });
  });

  it('reports ready when the database and configured surfaces are available', async () => {
    const mandateSigner = { sign: vi.fn(), verify: vi.fn() } as unknown as MandateSigner;
    const commerceProvider = { id: 'mock-vuelaya-commerce', merchantId: '10000000-0000-4000-8000-000000000001' } as CommerceProvider;
    const response = await request(createApp({ config, database, mandateSigner, commerceProviders: [commerceProvider], logger: pino({ level: 'silent' }) })).get('/ready');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready', checks: { database: true, mandateSigner: true, commerce: true, paymentCredentialProvider: true } });
  });
});
