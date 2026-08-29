import { Router } from 'express';
import { z } from 'zod';

import type { DatabaseClient } from '../../database/client.js';
import { validateBody } from '../../http/validate.js';
import { HttpError } from '../../shared/http-error.js';
import { authenticate, requireCsrf } from '../auth/session.js';
import { addIntentMessageSchema, createPurchaseIntentSchema } from './purchase-intent-schemas.js';
import { PurchaseIntentService } from './purchase-intent-service.js';
import type { PurchasingAgentProvider } from './purchasing-agent-provider.js';

const intentIdSchema = z.uuid();

function parseIntentId(value: unknown): string {
  const result = intentIdSchema.safeParse(value);
  if (!result.success) throw new HttpError(404, 'PURCHASE_INTENT_NOT_FOUND', 'Purchase intent not found');
  return result.data;
}

export function createPurchaseIntentRouter(
  database: DatabaseClient,
  agentProvider: PurchasingAgentProvider,
): Router {
  const router = Router();
  const service = new PurchaseIntentService(database, agentProvider);
  const requireAuthentication = authenticate(database);

  router.use(requireAuthentication);

  router.post('/', requireCsrf, validateBody(createPurchaseIntentSchema), async (request, response) => {
    const result = await service.create(request.auth!.user.id, request.body);
    response.status(201).json(result);
  });

  router.get('/', async (request, response) => {
    response.json({ intents: await service.list(request.auth!.user.id) });
  });

  router.post(
    '/:intentId/messages',
    requireCsrf,
    validateBody(addIntentMessageSchema),
    async (request, response) => {
      const result = await service.addMessage(
        request.auth!.user.id,
        parseIntentId(request.params.intentId),
        request.body.content,
      );
      response.status(201).json(result);
    },
  );

  router.post('/:intentId/finalize-specifications', requireCsrf, async (request, response) => {
    const result = await service.finalize(request.auth!.user.id, parseIntentId(request.params.intentId));
    response.json(result);
  });

  router.get('/:intentId', async (request, response) => {
    response.json(await service.get(request.auth!.user.id, parseIntentId(request.params.intentId)));
  });

  return router;
}
