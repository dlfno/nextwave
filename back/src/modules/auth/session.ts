import type { CookieOptions, RequestHandler, Response } from 'express';
import { and, eq, gt } from 'drizzle-orm';

import type { AppConfig } from '../../config.js';
import type { DatabaseClient } from '../../database/client.js';
import { sessions, users } from '../../database/schema.js';
import { HttpError } from '../../shared/http-error.js';
import { hashesEqual, hashToken, tokensEqual } from '../../shared/tokens.js';

export const SESSION_COOKIE = 'nextwave_session';
export const CSRF_COOKIE = 'nextwave_csrf';

function baseCookieOptions(config: AppConfig): CookieOptions {
  return {
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  };
}

export function setSessionCookies(
  response: Response,
  config: AppConfig,
  sessionToken: string,
  csrfToken: string,
  expiresAt: Date,
): void {
  response.cookie(SESSION_COOKIE, sessionToken, {
    ...baseCookieOptions(config),
    httpOnly: true,
    expires: expiresAt,
  });
  response.cookie(CSRF_COOKIE, csrfToken, {
    ...baseCookieOptions(config),
    httpOnly: false,
    expires: expiresAt,
  });
}

export function clearSessionCookies(response: Response, config: AppConfig): void {
  response.clearCookie(SESSION_COOKIE, { ...baseCookieOptions(config), httpOnly: true });
  response.clearCookie(CSRF_COOKIE, { ...baseCookieOptions(config), httpOnly: false });
}

export function authenticate(database: DatabaseClient): RequestHandler {
  return async (request, _response, next) => {
    const token = request.cookies[SESSION_COOKIE] as string | undefined;
    if (!token) {
      next(new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required'));
      return;
    }

    const [record] = await database.db
      .select({
        sessionId: sessions.id,
        csrfHash: sessions.csrfHash,
        expiresAt: sessions.expiresAt,
        reauthenticatedAt: sessions.reauthenticatedAt,
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);

    if (!record) {
      next(new HttpError(401, 'INVALID_SESSION', 'Session is invalid or expired'));
      return;
    }

    request.auth = {
      user: {
        id: record.userId,
        email: record.email,
        displayName: record.displayName,
        role: record.role,
      },
      session: {
        id: record.sessionId,
        csrfHash: record.csrfHash,
        expiresAt: record.expiresAt,
        reauthenticatedAt: record.reauthenticatedAt,
      },
    };
    next();
  };
}

export const requireCsrf: RequestHandler = (request, _response, next) => {
  const headerToken = request.get('x-csrf-token');
  const cookieToken = request.cookies[CSRF_COOKIE] as string | undefined;
  const expectedHash = request.auth?.session.csrfHash;

  if (
    !headerToken ||
    !cookieToken ||
    !expectedHash ||
    !tokensEqual(headerToken, cookieToken) ||
    !hashesEqual(hashToken(headerToken), expectedHash)
  ) {
    next(new HttpError(403, 'CSRF_TOKEN_INVALID', 'CSRF token is missing or invalid'));
    return;
  }

  next();
};
