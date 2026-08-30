import { z } from 'zod';

const webDiscoverySourceSchema = z.object({
  id: z.string().min(1), merchantId: z.uuid(),
  searchUrlTemplate: z.string().url().refine((value) => value.startsWith('https://'), 'must use HTTPS'),
}).strict();

function jsonArray(value: unknown): unknown {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:4200'),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(168).default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OPENAI_API_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
  OPENAI_CLARIFICATION_MODEL: z.string().min(1).optional(),
  OPENAI_RESEARCH_MODEL: z.string().min(1).optional(),
  OPENAI_AGENT_MODEL: z.string().min(1).optional(),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  DUFFEL_ACCESS_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
  DUFFEL_SUPPLIER_TIMEOUT_MS: z.coerce.number().int().min(2_000).max(60_000).default(10_000),
  DUFFEL_SEARCH_TIMEOUT_MS: z.coerce.number().int().min(3_000).max(65_000).default(15_000),
  DUFFEL_MAX_OFFERS: z.coerce.number().int().min(1).max(50).default(20),
  PAYMENT_CREDENTIAL_PROVIDER: z.enum(['mock', 'stripe-spt-test']).default('mock'),
  STRIPE_SECRET_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().startsWith('sk_test_').optional(),
  ),
  STRIPE_SPT_TEST_PAYMENT_METHOD: z.string().min(1).default('pm_card_visa'),
  STRIPE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  WEB_DISCOVERY_SOURCES_JSON: z.preprocess(jsonArray, z.array(webDiscoverySourceSchema).max(5)).default([]),
  WEB_DISCOVERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(15_000).default(4_000),
  WEB_DISCOVERY_MAX_BYTES: z.coerce.number().int().min(16_384).max(2_000_000).default(512_000),
}).superRefine((value, context) => {
  if (value.PAYMENT_CREDENTIAL_PROVIDER === 'stripe-spt-test' && !value.STRIPE_SECRET_KEY) {
    context.addIssue({
      code: 'custom', path: ['STRIPE_SECRET_KEY'],
      message: 'STRIPE_SECRET_KEY is required when Stripe SPT test mode is selected',
    });
  }
  if (value.DUFFEL_SEARCH_TIMEOUT_MS <= value.DUFFEL_SUPPLIER_TIMEOUT_MS) {
    context.addIssue({
      code: 'custom', path: ['DUFFEL_SEARCH_TIMEOUT_MS'],
      message: 'DUFFEL_SEARCH_TIMEOUT_MS must exceed DUFFEL_SUPPLIER_TIMEOUT_MS',
    });
  }
});

export interface AppConfig {
  port: number;
  databaseUrl: string;
  frontendOrigin: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  nodeEnv: 'development' | 'test' | 'production';
  openaiApiKey?: string;
  openaiClarificationModel?: string;
  openaiResearchModel?: string;
  openaiTimeoutMs?: number;
  duffelAccessToken?: string;
  duffelSupplierTimeoutMs?: number;
  duffelSearchTimeoutMs?: number;
  duffelMaxOffers?: number;
  paymentCredentialProvider?: 'mock' | 'stripe-spt-test';
  stripeSecretKey?: string;
  stripeSptTestPaymentMethod?: string;
  stripeTimeoutMs?: number;
  webDiscoverySources?: readonly z.infer<typeof webDiscoverySourceSchema>[];
  webDiscoveryTimeoutMs?: number;
  webDiscoveryMaxBytes?: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);

  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    frontendOrigin: parsed.FRONTEND_ORIGIN,
    sessionTtlHours: parsed.SESSION_TTL_HOURS,
    cookieSecure: parsed.COOKIE_SECURE === 'true',
    nodeEnv: parsed.NODE_ENV,
    ...(parsed.OPENAI_API_KEY ? { openaiApiKey: parsed.OPENAI_API_KEY } : {}),
    openaiClarificationModel: parsed.OPENAI_CLARIFICATION_MODEL ?? parsed.OPENAI_AGENT_MODEL ?? 'gpt-5.6-luna',
    openaiResearchModel: parsed.OPENAI_RESEARCH_MODEL ?? 'gpt-5.6-terra',
    openaiTimeoutMs: parsed.OPENAI_TIMEOUT_MS,
    ...(parsed.DUFFEL_ACCESS_TOKEN ? { duffelAccessToken: parsed.DUFFEL_ACCESS_TOKEN } : {}),
    duffelSupplierTimeoutMs: parsed.DUFFEL_SUPPLIER_TIMEOUT_MS,
    duffelSearchTimeoutMs: parsed.DUFFEL_SEARCH_TIMEOUT_MS,
    duffelMaxOffers: parsed.DUFFEL_MAX_OFFERS,
    paymentCredentialProvider: parsed.PAYMENT_CREDENTIAL_PROVIDER,
    ...(parsed.STRIPE_SECRET_KEY ? { stripeSecretKey: parsed.STRIPE_SECRET_KEY } : {}),
    stripeSptTestPaymentMethod: parsed.STRIPE_SPT_TEST_PAYMENT_METHOD,
    stripeTimeoutMs: parsed.STRIPE_TIMEOUT_MS,
    webDiscoverySources: parsed.WEB_DISCOVERY_SOURCES_JSON,
    webDiscoveryTimeoutMs: parsed.WEB_DISCOVERY_TIMEOUT_MS,
    webDiscoveryMaxBytes: parsed.WEB_DISCOVERY_MAX_BYTES,
  };
}
