import pino from 'pino';
import request, { type Response } from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const frontendOrigin = 'http://localhost:4200';
const testConfig: AppConfig = {
  port: 3000,
  databaseUrl: databaseUrl ?? 'postgresql://unused',
  frontendOrigin,
  sessionTtlHours: 12,
  cookieSecure: false,
  nodeEnv: 'test',
};

interface AuthenticatedAgent {
  client: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
}

function readCookie(response: Response, name: string): string {
  const setCookies = response.headers['set-cookie'];
  const values = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Response did not set ${name}`);
  return cookie.split(';', 1)[0]!.slice(name.length + 1);
}

describe.skipIf(!databaseUrl)('authentication and agent ownership', () => {
  let database: DatabaseClient;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    app = createApp({ config: testConfig, database, logger: pino({ level: 'silent' }) });
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE users CASCADE');
  });

  async function register(email: string): Promise<AuthenticatedAgent> {
    const client = request.agent(app);
    const response = await client
      .post('/api/v1/auth/register')
      .set('Origin', frontendOrigin)
      .send({ email, password: 'correct-horse-battery', displayName: 'Marta' })
      .expect(201);

    return {
      client,
      csrfToken: readCookie(response, 'nextwave_csrf'),
      userId: response.body.user.id as string,
    };
  }

  it('registers a user, establishes an opaque session, and returns the current user', async () => {
    const authenticated = await register('Marta@example.com');

    const me = await authenticated.client.get('/api/v1/auth/me').expect(200);
    expect(me.body.user).toMatchObject({
      id: authenticated.userId,
      email: 'marta@example.com',
      displayName: 'Marta',
      role: 'HUMAN',
    });
    expect(me.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects duplicate emails case-insensitively', async () => {
    await register('marta@example.com');
    await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', frontendOrigin)
      .send({ email: 'MARTA@example.com', password: 'another-secure-password', displayName: 'Other' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('EMAIL_ALREADY_REGISTERED'));
  });

  it('requires an allowed origin for state-changing requests', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', 'https://attacker.example')
      .send({ email: 'marta@example.com', password: 'correct-horse-battery', displayName: 'Marta' })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('ORIGIN_NOT_ALLOWED'));
  });

  it('requires the CSRF cookie and matching header for authenticated commands', async () => {
    const authenticated = await register('marta@example.com');

    await authenticated.client
      .post('/api/v1/agents')
      .set('Origin', frontendOrigin)
      .send({ name: 'Marta Agent' })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('CSRF_TOKEN_INVALID'));

    await authenticated.client
      .post('/api/v1/agents')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', 'wrong-token')
      .send({ name: 'Marta Agent' })
      .expect(403);
  });

  it('creates and lists only agents owned by the authenticated user', async () => {
    const marta = await register('marta@example.com');
    const created = await marta.client
      .post('/api/v1/agents')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', marta.csrfToken)
      .send({ name: 'Marta Purchasing Agent' })
      .expect(201);

    const other = await register('other@example.com');
    await other.client.get(`/api/v1/agents/${created.body.agent.id}`).expect(404);

    const list = await marta.client.get('/api/v1/agents').expect(200);
    expect(list.body.agents).toHaveLength(1);
    expect(list.body.agents[0].name).toBe('Marta Purchasing Agent');
  });

  it('invalidates an expired database session immediately', async () => {
    const authenticated = await register('marta@example.com');
    await database.pool.query(
      "UPDATE sessions SET expires_at = created_at + interval '1 millisecond' WHERE user_id = $1",
      [authenticated.userId],
    );

    await authenticated.client
      .get('/api/v1/auth/me')
      .expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('INVALID_SESSION'));
  });

  it('reauthenticates and logs out using CSRF-protected commands', async () => {
    const authenticated = await register('marta@example.com');

    await authenticated.client
      .post('/api/v1/auth/reauthenticate')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', authenticated.csrfToken)
      .send({ password: 'wrong-password-value' })
      .expect(401);

    await authenticated.client
      .post('/api/v1/auth/reauthenticate')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', authenticated.csrfToken)
      .send({ password: 'correct-horse-battery' })
      .expect(200);

    await authenticated.client
      .post('/api/v1/auth/logout')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', authenticated.csrfToken)
      .expect(204);

    await authenticated.client.get('/api/v1/auth/me').expect(401);
  });

  it('logs in with valid credentials and returns a generic failure otherwise', async () => {
    await register('marta@example.com');

    await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', frontendOrigin)
      .send({ email: 'marta@example.com', password: 'incorrect-password' })
      .expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('INVALID_CREDENTIALS'));

    await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', frontendOrigin)
      .send({ email: 'marta@example.com', password: 'correct-horse-battery' })
      .expect(200);
  });
});
