import { Router } from 'express';
import { z } from 'zod';

import type { DatabaseClient } from '../../database/client.js';
import { validateBody } from '../../http/validate.js';
import { HttpError } from '../../shared/http-error.js';
import { authenticate, requireCsrf, requireRecentAuthentication } from '../auth/session.js';
import {
  createMandateDraftSchema,
  createMandateVersionSchema,
  revokeMandateSchema,
} from './mandate-schemas.js';
import { MandateService } from './mandate-service.js';
import type { MandateSigner } from './mandate-signer.js';

const uuidSchema = z.uuid();
const versionSchema = z.coerce.number().int().positive();

function parseUuid(value: unknown, code: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(404, code, 'Resource not found');
  return parsed.data;
}

function parseVersion(value: unknown): number {
  const parsed = versionSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'MANDATE_VERSION_NOT_FOUND', 'Mandate version not found');
  return parsed.data;
}

export function createMandateRouter(database: DatabaseClient, signer: MandateSigner): Router {
  const router = Router();
  const service = new MandateService(database, signer);
  const requireAuthentication = authenticate(database);
  const requireRecent = requireRecentAuthentication();

  router.use(requireAuthentication);

  router.post(
    '/purchase-intents/:intentId/mandates/draft',
    requireCsrf,
    validateBody(createMandateDraftSchema),
    async (request, response) => {
      const result = await service.createDraft(
        request.auth!.user.id,
        parseUuid(request.params.intentId, 'PURCHASE_INTENT_NOT_FOUND'),
        request.body.mode,
      );
      response.status(201).json(result);
    },
  );

  router.get('/mandates', async (request, response) => {
    response.json({ mandates: await service.list(request.auth!.user.id) });
  });

  router.get('/mandates/:mandateId', async (request, response) => {
    response.json(await service.get(
      request.auth!.user.id,
      parseUuid(request.params.mandateId, 'MANDATE_NOT_FOUND'),
    ));
  });

  router.post('/mandates/:mandateId/authorize', requireCsrf, requireRecent, async (request, response) => {
    response.json(await service.authorize(
      request.auth!.user.id,
      parseUuid(request.params.mandateId, 'MANDATE_NOT_FOUND'),
    ));
  });

  router.post(
    '/mandates/:mandateId/versions',
    requireCsrf,
    validateBody(createMandateVersionSchema),
    async (request, response) => {
      const result = await service.createVersion(
        request.auth!.user.id,
        parseUuid(request.params.mandateId, 'MANDATE_NOT_FOUND'),
        request.body.authorizationSpecification,
      );
      response.status(201).json(result);
    },
  );

  router.post(
    '/mandates/:mandateId/versions/:version/authorize',
    requireCsrf,
    requireRecent,
    async (request, response) => {
      response.json(await service.authorize(
        request.auth!.user.id,
        parseUuid(request.params.mandateId, 'MANDATE_NOT_FOUND'),
        parseVersion(request.params.version),
      ));
    },
  );

  router.post(
    '/mandates/:mandateId/revoke',
    requireCsrf,
    requireRecent,
    validateBody(revokeMandateSchema),
    async (request, response) => {
      response.json(await service.revoke(
        request.auth!.user.id,
        parseUuid(request.params.mandateId, 'MANDATE_NOT_FOUND'),
        request.body.reason,
      ));
    },
  );

  return router;
}
