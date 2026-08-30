import { Router } from 'express';
import { z } from 'zod';

import type { DatabaseClient } from '../../database/client.js';
import { HttpError } from '../../shared/http-error.js';
import { authenticate, requireCsrf } from '../auth/session.js';
import { DiscoveryEngine } from './discovery-engine.js';
import { DiscoveryService } from './discovery-service.js';

const idSchema = z.uuid();

function parseId(value: unknown, code: string, message: string): string {
  const result = idSchema.safeParse(value);
  if (!result.success) throw new HttpError(404, code, message);
  return result.data;
}

export function createDiscoveryRouter(database: DatabaseClient, engine: DiscoveryEngine): Router {
  const router = Router();
  const service = new DiscoveryService(database, engine);
  router.use(authenticate(database));

  router.post('/purchase-intents/:intentId/discovery-runs', requireCsrf, async (request, response) => {
    const result = await service.start(request.auth!.user.id, parseId(
      request.params.intentId, 'PURCHASE_INTENT_NOT_FOUND', 'Purchase intent not found',
    ));
    response.status(201).json(result);
  });

  router.get('/discovery-runs/:runId', async (request, response) => {
    response.json(await service.get(request.auth!.user.id, parseId(
      request.params.runId, 'DISCOVERY_RUN_NOT_FOUND', 'Discovery run not found',
    )));
  });

  router.get('/discovery-runs/:runId/offers', async (request, response) => {
    response.json(await service.listOffers(request.auth!.user.id, parseId(
      request.params.runId, 'DISCOVERY_RUN_NOT_FOUND', 'Discovery run not found',
    )));
  });

  return router;
}
