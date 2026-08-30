import { z } from 'zod';

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
  PAYMENT_CREDENTIAL_PROVIDER: z.enum(['mock', 'stripe-spt-test']).default('mock'),
  STRIPE_SECRET_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().startsWith('sk_test_').optional(),
  ),
  STRIPE_SPT_TEST_PAYMENT_METHOD: z.string().min(1).default('pm_card_visa'),
  STRIPE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
}).superRefine((value, context) => {
  if (value.PAYMENT_CREDENTIAL_PROVIDER === 'stripe-spt-test' && !value.STRIPE_SECRET_KEY) {
    context.addIssue({
      code: 'custom', path: ['STRIPE_SECRET_KEY'],
      message: 'STRIPE_SECRET_KEY is required when Stripe SPT test mode is selected',
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
  paymentCredentialProvider?: 'mock' | 'stripe-spt-test';
  stripeSecretKey?: string;
  stripeSptTestPaymentMethod?: string;
  stripeTimeoutMs?: number;
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
    paymentCredentialProvider: parsed.PAYMENT_CREDENTIAL_PROVIDER,
    ...(parsed.STRIPE_SECRET_KEY ? { stripeSecretKey: parsed.STRIPE_SECRET_KEY } : {}),
    stripeSptTestPaymentMethod: parsed.STRIPE_SPT_TEST_PAYMENT_METHOD,
    stripeTimeoutMs: parsed.STRIPE_TIMEOUT_MS,
  };
}
