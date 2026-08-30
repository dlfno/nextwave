import 'dotenv/config';

import pino from 'pino';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabaseClient } from './database/client.js';
import {
  Es256CheckoutSigner,
  HttpUcpCommerceProvider,
  HttpUcpDiscoveryProvider,
  MockAeroSurCommerceProvider,
  MockNubeViaCommerceProvider,
  MockVuelaYaCommerceProvider,
} from './modules/commerce/index.js';
import {
  DiscoveryEngine,
  MockAeroSurDiscoveryProvider,
  MockNubeViaUcpDiscoveryProvider,
  MockVuelaYaDiscoveryProvider,
  WebDiscoveryProvider,
} from './modules/discovery/index.js';
import { Es256MandateSigner } from './modules/mandates/mandate-signer.js';
import { Ap2CredentialIssuer } from './modules/mandates/ap2-credential.js';
import { MockPaymentCredentialProvider, StripeSPTProvider } from './modules/payments/index.js';
import { OpenAIPurchasingAgentProvider } from './modules/purchase-intents/openai-purchasing-agent-provider.js';
import { MockPurchasingAgentProvider } from './modules/purchase-intents/purchasing-agent-provider.js';

const config = loadConfig();
const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    censor: '[REDACTED]',
  },
});
const database = createDatabaseClient(config.databaseUrl);
const signingKey = process.env.MANDATE_SIGNING_PRIVATE_JWK;
if (!signingKey) throw new Error('MANDATE_SIGNING_PRIVATE_JWK is required');
const mandateSigner = await Es256MandateSigner.create(
  JSON.parse(signingKey) as Record<string, unknown>,
  process.env.MANDATE_SIGNING_KEY_ID ?? 'nextwave-trusted-surface-1',
);
const agentSigningKey = process.env.AGENT_SIGNING_PRIVATE_JWK;
if (!agentSigningKey) throw new Error('AGENT_SIGNING_PRIVATE_JWK is required');
const ap2TrustedIssuer = await Ap2CredentialIssuer.create(
  JSON.parse(signingKey) as Record<string, unknown>,
  process.env.MANDATE_SIGNING_KEY_ID ?? 'nextwave-trusted-surface-1',
  'urn:nextwave:trusted-agent-provider',
);
const ap2AgentIssuer = await Ap2CredentialIssuer.create(
  JSON.parse(agentSigningKey) as Record<string, unknown>,
  process.env.AGENT_SIGNING_KEY_ID ?? 'nextwave-shopping-agent-1',
  'urn:nextwave:shopping-agent',
);
const checkoutSigningKey = process.env.VUELAYA_SIGNING_PRIVATE_JWK;
if (!checkoutSigningKey) throw new Error('VUELAYA_SIGNING_PRIVATE_JWK is required');
const checkoutSigner = await Es256CheckoutSigner.create(
  JSON.parse(checkoutSigningKey) as Record<string, unknown>,
  process.env.VUELAYA_SIGNING_KEY_ID ?? 'vuela-ya-checkout-1',
);
const paymentReceiptSigner = await Es256CheckoutSigner.create(
  JSON.parse(signingKey) as Record<string, unknown>,
  'nextwave-payment-processor-1',
);
const nubeViaBaseUrl = process.env.NUBEVIA_UCP_BASE_URL;
const commerceProviders = [
  new MockVuelaYaCommerceProvider(checkoutSigner),
  new MockAeroSurCommerceProvider(checkoutSigner),
  nubeViaBaseUrl
    ? new HttpUcpCommerceProvider(nubeViaBaseUrl)
    : new MockNubeViaCommerceProvider(checkoutSigner),
];
const discoveryEngine = new DiscoveryEngine([
  new MockVuelaYaDiscoveryProvider(),
  new MockAeroSurDiscoveryProvider(),
  nubeViaBaseUrl
    ? new HttpUcpDiscoveryProvider(nubeViaBaseUrl)
    : new MockNubeViaUcpDiscoveryProvider(),
  ...((config.webDiscoverySources?.length ?? 0) > 0 ? [new WebDiscoveryProvider(
    config.webDiscoverySources!,
    { timeoutMs: config.webDiscoveryTimeoutMs ?? 4_000,
      maxResponseBytes: config.webDiscoveryMaxBytes ?? 512_000 },
  )] : []),
]);
const paymentCredentialProvider = config.paymentCredentialProvider === 'stripe-spt-test'
  ? new StripeSPTProvider({
      apiKey: config.stripeSecretKey!,
      paymentMethod: config.stripeSptTestPaymentMethod ?? 'pm_card_visa',
      timeoutMs: config.stripeTimeoutMs ?? 10_000,
    })
  : new MockPaymentCredentialProvider(paymentReceiptSigner);
const agentProvider = config.openaiApiKey
  ? new OpenAIPurchasingAgentProvider({
      apiKey: config.openaiApiKey,
      model: config.openaiClarificationModel ?? 'gpt-5.6-luna',
      timeoutMs: config.openaiTimeoutMs ?? 20_000,
    })
  : new MockPurchasingAgentProvider();
logger.info({
  provider: agentProvider instanceof OpenAIPurchasingAgentProvider ? agentProvider.id : 'mock',
  clarificationModel: config.openaiClarificationModel,
  researchModel: config.openaiResearchModel,
}, 'Purchasing agent configured');
const app = createApp({
  config, database, logger, mandateSigner, ap2TrustedIssuer, ap2AgentIssuer,
  discoveryEngine, commerceProviders,
  paymentCredentialProvider, agentProvider,
});

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
