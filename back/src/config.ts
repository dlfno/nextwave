import { z } from 'zod';

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:4200'),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(168).default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export interface AppConfig {
  port: number;
  databaseUrl: string;
  frontendOrigin: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  nodeEnv: 'development' | 'test' | 'production';
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
  };
}
