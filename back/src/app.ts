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
import { createAuthorizationRouter } from './modules/authorization/index.js';
import { createAuthRouter } from './modules/auth/auth-router.js';
import { createCheckoutRouter, type CommerceProvider, UnavailableCommerceProvider } from './modules/commerce/index.js';
import {
  createDiscoveryRouter,
  DiscoveryEngine,
  MockAeroSurDiscoveryProvider,
  MockNubeViaUcpDiscoveryProvider,
  MockVuelaYaDiscoveryProvider,
} from './modules/discovery/index.js';
import { VUELAYA_MERCHANT_ID } from './modules/discovery/mock-vuelaya-provider.js';
import { createMandateRouter } from './modules/mandates/mandate-router.js';
import type { Ap2CredentialIssuer } from './modules/mandates/ap2-credential.js';
import { type MandateSigner, UnavailableMandateSigner } from './modules/mandates/mandate-signer.js';
import { createPurchaseIntentRouter } from './modules/purchase-intents/purchase-intent-router.js';
import { createPaymentRouter, MockPaymentCredentialProvider, type PaymentCredentialProvider } from './modules/payments/index.js';
import { createRecordsRouter } from './modules/records/index.js';
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
  ap2TrustedIssuer?: Ap2CredentialIssuer;
  ap2AgentIssuer?: Ap2CredentialIssuer;
  discoveryEngine?: DiscoveryEngine;
  commerceProviders?: readonly CommerceProvider[];
  paymentCredentialProvider?: PaymentCredentialProvider;
}

export function createApp({
  config,
  database,
  logger = pino(),
  agentProvider = new MockPurchasingAgentProvider(),
  mandateSigner = new UnavailableMandateSigner(),
  ap2TrustedIssuer,
  ap2AgentIssuer,
  discoveryEngine = new DiscoveryEngine([
    new MockVuelaYaDiscoveryProvider(),
    new MockAeroSurDiscoveryProvider(),
    new MockNubeViaUcpDiscoveryProvider(),
  ]),
  commerceProviders = [new UnavailableCommerceProvider(VUELAYA_MERCHANT_ID)],
  paymentCredentialProvider = new MockPaymentCredentialProvider(),
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
  app.get('/.well-known/ucp', (_request, response) => {
    const keys = [ap2TrustedIssuer?.publicJwk(), ap2AgentIssuer?.publicJwk()].filter(Boolean);
    response.json({
      ucp: {
        version: '2026-04-08', services: {},
        capabilities: {
          'dev.ucp.shopping.checkout': [{ version: '2026-04-08' }],
          'dev.ucp.common.payment.ap2_mandate': [{
            version: '2026-04-08', extends: 'dev.ucp.shopping.checkout',
            config: { vp_formats_supported: { 'dc+sd-jwt': {} } },
          }],
        }, payment_handlers: {},
      }, keys,
    });
  });
  app.get('/ready', async (_request, response) => {
    const checks = {
      database: false,
      mandateSigner: !(mandateSigner instanceof UnavailableMandateSigner),
      commerce: commerceProviders.some((provider) => provider.id !== 'unavailable-commerce'),
      paymentCredentialProvider: paymentCredentialProvider.id !== 'stripe-spt',
    };
    try {
      await database.pool.query('SELECT 1');
      checks.database = true;
    } catch {
      checks.database = false;
    }
    const ready = Object.values(checks).every(Boolean);
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });
  app.use('/api/v1/auth', createAuthRouter(database, config));
  app.use('/api/v1/agents', createAgentRouter(database));
  app.use('/api/v1/purchase-intents', createPurchaseIntentRouter(database, agentProvider));
  app.use('/api/v1', createMandateRouter(database, mandateSigner, ap2TrustedIssuer, ap2AgentIssuer));
  app.use('/api/v1', createDiscoveryRouter(database, discoveryEngine));
  app.use('/api/v1', createCheckoutRouter(database, commerceProviders));
  app.use('/api/v1', createAuthorizationRouter(database, mandateSigner, commerceProviders));
  app.use('/api/v1', createPaymentRouter(
    database, mandateSigner, commerceProviders, paymentCredentialProvider, ap2TrustedIssuer, ap2AgentIssuer,
  ));
  app.use('/api/v1', createRecordsRouter(database));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
