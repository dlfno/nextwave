import { Router } from 'express';
import { z } from 'zod';

import type { DatabaseClient } from '../../database/client.js';
import { validateBody } from '../../http/validate.js';
import { HttpError } from '../../shared/http-error.js';
import { authenticate, requireCsrf, requireRecentAuthentication } from '../auth/session.js';
import type { CommerceProvider } from '../commerce/commerce-types.js';
import type { MandateSigner } from '../mandates/mandate-signer.js';
import { PurchaseAuthorizationService } from './purchase-authorization-service.js';

const uuidSchema = z.uuid();
const approvalSchema = z.object({ decision: z.enum(['APPROVED', 'DENIED']) }).strict();

function parseAttemptId(value: unknown): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'PURCHASE_ATTEMPT_NOT_FOUND', 'Purchase attempt not found');
  return parsed.data;
}

export function createAuthorizationRouter(
  database: DatabaseClient,
  mandateSigner: MandateSigner,
  providers: readonly CommerceProvider[],
): Router {
  const router = Router();
  const service = new PurchaseAuthorizationService(database, mandateSigner, providers);
  router.use(authenticate(database));

  router.post('/purchase-attempts/:attemptId/evaluate', requireCsrf, async (request, response) => {
    response.json({ decision: await service.evaluate(
      request.auth!.user.id,
      parseAttemptId(request.params.attemptId),
    ) });
  });

  router.post('/purchase-attempts/:attemptId/approval', requireCsrf,
    requireRecentAuthentication(), validateBody(approvalSchema), async (request, response) => {
      response.status(201).json(await service.decide(
        request.auth!.user.id,
        parseAttemptId(request.params.attemptId),
        request.body.decision,
      ));
    });

  return router;
}
