import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import type { AppConfig } from './config.js';
import type { DatabaseClient } from './database/client.js';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { requireAllowedOrigin } from './http/origin.js';
import { createAgentRouter } from './modules/agents/agent-router.js';
import { createAuthRouter } from './modules/auth/auth-router.js';
import { createDiscoveryRouter, DiscoveryEngine, MockVuelaYaDiscoveryProvider } from './modules/discovery/index.js';
import { createMandateRouter } from './modules/mandates/mandate-router.js';
import { type MandateSigner, UnavailableMandateSigner } from './modules/mandates/mandate-signer.js';
import { createPurchaseIntentRouter } from './modules/purchase-intents/purchase-intent-router.js';
import {
  MockPurchasingAgentProvider,
  type PurchasingAgentProvider,
} from './modules/purchase-intents/purchasing-agent-provider.js';

interface AppDependencies {
  config: AppConfig;
  database: DatabaseClient;
  logger?: Logger;
  agentProvider?: PurchasingAgentProvider;
  mandateSigner?: MandateSigner;
  discoveryEngine?: DiscoveryEngine;
}

export function createApp({
  config,
  database,
  logger = pino(),
  agentProvider = new MockPurchasingAgentProvider(),
  mandateSigner = new UnavailableMandateSigner(),
  discoveryEngine = new DiscoveryEngine([new MockVuelaYaDiscoveryProvider()]),
}: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(pinoHttp({ logger, genReqId: () => randomUUID() }));
  app.use(helmet());
  app.use(cors({ origin: config.frontendOrigin, credentials: true }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use(requireAllowedOrigin(config.frontendOrigin));

  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.use('/api/v1/auth', createAuthRouter(database, config));
  app.use('/api/v1/agents', createAgentRouter(database));
  app.use('/api/v1/purchase-intents', createPurchaseIntentRouter(database, agentProvider));
  app.use('/api/v1', createMandateRouter(database, mandateSigner));
  app.use('/api/v1', createDiscoveryRouter(database, discoveryEngine));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
