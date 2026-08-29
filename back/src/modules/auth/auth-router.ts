import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import type { AppConfig } from '../../config.js';
import type { DatabaseClient } from '../../database/client.js';
import { validateBody } from '../../http/validate.js';
import { AuthService } from './auth-service.js';
import { loginSchema, reauthenticateSchema, registerSchema } from './auth-schemas.js';
import { authenticate, clearSessionCookies, requireCsrf, setSessionCookies } from './session.js';

export function createAuthRouter(database: DatabaseClient, config: AppConfig): Router {
  const router = Router();
  const service = new AuthService(database, config);
  const requireAuthentication = authenticate(database);
  const credentialRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });

  router.post('/register', credentialRateLimit, validateBody(registerSchema), async (request, response) => {
    const result = await service.register(request.body);
    setSessionCookies(
      response,
      config,
      result.session.sessionToken,
      result.session.csrfToken,
      result.session.expiresAt,
    );
    response.status(201).json({ user: result.user, expiresAt: result.session.expiresAt });
  });

  router.post('/login', credentialRateLimit, validateBody(loginSchema), async (request, response) => {
    const result = await service.login(request.body);
    setSessionCookies(
      response,
      config,
      result.session.sessionToken,
      result.session.csrfToken,
      result.session.expiresAt,
    );
    response.json({ user: result.user, expiresAt: result.session.expiresAt });
  });

  router.get('/me', requireAuthentication, (request, response) => {
    response.json({
      user: request.auth!.user,
      session: {
        expiresAt: request.auth!.session.expiresAt,
        reauthenticatedAt: request.auth!.session.reauthenticatedAt,
      },
    });
  });

  router.post(
    '/reauthenticate',
    requireAuthentication,
    requireCsrf,
    credentialRateLimit,
    validateBody(reauthenticateSchema),
    async (request, response) => {
      const reauthenticatedAt = await service.reauthenticate(
        request.auth!.user.id,
        request.auth!.session.id,
        request.body.password,
      );
      response.json({ reauthenticatedAt });
    },
  );

  router.post('/logout', requireAuthentication, requireCsrf, async (request, response) => {
    await service.logout(request.auth!.session.id);
    clearSessionCookies(response, config);
    response.status(204).send();
  });

  return router;
}
