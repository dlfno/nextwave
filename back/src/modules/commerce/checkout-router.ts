import { Router } from 'express';
import { z } from 'zod';

import type { DatabaseClient } from '../../database/client.js';
import { validateBody } from '../../http/validate.js';
import { HttpError } from '../../shared/http-error.js';
import { authenticate, requireCsrf } from '../auth/session.js';
import { CheckoutService } from './checkout-service.js';
import type { CommerceProvider } from './commerce-types.js';

const uuidSchema = z.uuid();
const selectOfferSchema = z.object({ offerId: z.uuid() }).strict();

function parseUuid(value: unknown): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
  return parsed.data;
}

export function createCheckoutRouter(database: DatabaseClient, providers: readonly CommerceProvider[]): Router {
  const router = Router();
  const service = new CheckoutService(database, providers);
  router.use(authenticate(database));

  const createAttempt = async (request: Parameters<Parameters<Router['post']>[1]>[0], response: Parameters<Parameters<Router['post']>[1]>[1]) => {
    const result = await service.createAttempt(
      request.auth!.user.id,
      parseUuid(request.params.intentId),
      request.body.offerId,
    );
    response.status(201).json(result);
  };

  router.post('/purchase-intents/:intentId/select-offer', requireCsrf,
    validateBody(selectOfferSchema), createAttempt);
  router.post('/purchase-intents/:intentId/purchase-attempts', requireCsrf,
    validateBody(selectOfferSchema), createAttempt);

  router.get('/purchase-attempts/:attemptId', async (request, response) => {
    response.json(await service.getAttempt(request.auth!.user.id, parseUuid(request.params.attemptId)));
  });

  return router;
}
