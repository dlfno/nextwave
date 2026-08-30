import { z } from 'zod';

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:4200'),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(168).default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_AGENT_MODEL: z.string().min(1).default('gpt-5.6-terra'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
});

export interface AppConfig {
  port: number;
  databaseUrl: string;
  frontendOrigin: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  nodeEnv: 'development' | 'test' | 'production';
  openaiApiKey?: string;
  openaiAgentModel?: string;
  openaiTimeoutMs?: number;
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
    openaiAgentModel: parsed.OPENAI_AGENT_MODEL,
    openaiTimeoutMs: parsed.OPENAI_TIMEOUT_MS,
  };
}
