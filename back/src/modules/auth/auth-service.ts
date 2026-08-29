import argon2 from 'argon2';
import { eq } from 'drizzle-orm';

import type { AppConfig } from '../../config.js';
import type { DatabaseClient } from '../../database/client.js';
import { sessions, users } from '../../database/schema.js';
import { HttpError } from '../../shared/http-error.js';
import { createToken, hashToken } from '../../shared/tokens.js';
import type { LoginInput, RegisterInput } from './auth-schemas.js';

interface NewSession {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}

export class AuthService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly config: AppConfig,
  ) {}

  async register(input: RegisterInput) {
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

    try {
      return await this.database.db.transaction(async (transaction) => {
        const [user] = await transaction
          .insert(users)
          .values({ email: input.email, passwordHash, displayName: input.displayName })
          .returning({ id: users.id, email: users.email, displayName: users.displayName, role: users.role });

        if (!user) throw new Error('User insert did not return a row');
        const session = await this.createSession(user.id, transaction);
        return { user, session };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists');
      }
      throw error;
    }
  }

  async login(input: LoginInput) {
    const [userWithPassword] = await this.database.db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    if (!userWithPassword || !(await argon2.verify(userWithPassword.passwordHash, input.password))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    const session = await this.createSession(userWithPassword.id, this.database.db);
    return {
      user: {
        id: userWithPassword.id,
        email: userWithPassword.email,
        displayName: userWithPassword.displayName,
        role: userWithPassword.role,
      },
      session,
    };
  }

  async reauthenticate(userId: string, sessionId: string, password: string): Promise<Date> {
    const [user] = await this.database.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
    }

    const reauthenticatedAt = new Date();
    await this.database.db
      .update(sessions)
      .set({ reauthenticatedAt })
      .where(eq(sessions.id, sessionId));
    return reauthenticatedAt;
  }

  async logout(sessionId: string): Promise<void> {
    await this.database.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  private async createSession(
    userId: string,
    database: Pick<DatabaseClient['db'], 'insert'>,
  ): Promise<NewSession> {
    const sessionToken = createToken();
    const csrfToken = createToken();
    const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 60 * 60 * 1000);

    await database.insert(sessions).values({
      userId,
      tokenHash: hashToken(sessionToken),
      csrfHash: hashToken(csrfToken),
      expiresAt,
      reauthenticatedAt: new Date(),
    });

    return { sessionToken, csrfToken, expiresAt };
  }
}
