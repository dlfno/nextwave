import { Router } from 'express';
import { z } from 'zod';

import type { DatabaseClient } from '../../database/client.js';
import { HttpError } from '../../shared/http-error.js';
import { authenticate, requireCsrf } from '../auth/session.js';
import type { CommerceProvider } from '../commerce/commerce-types.js';
import type { MandateSigner } from '../mandates/mandate-signer.js';
import { PaymentService } from './payment-service.js';
import type { PaymentCredentialProvider } from './payment-types.js';

const uuidSchema = z.uuid();

export function createPaymentRouter(
  database: DatabaseClient,
  mandateSigner: MandateSigner,
  commerceProviders: readonly CommerceProvider[],
  credentialProvider: PaymentCredentialProvider,
): Router {
  const router = Router();
  const service = new PaymentService(database, mandateSigner, commerceProviders, credentialProvider);
  router.use(authenticate(database));

  router.post('/purchase-attempts/:attemptId/execute', requireCsrf, async (request, response) => {
    const parsed = uuidSchema.safeParse(request.params.attemptId);
    if (!parsed.success) throw new HttpError(404, 'PURCHASE_ATTEMPT_NOT_FOUND', 'Purchase attempt not found');
    response.json(await service.execute(request.auth!.user.id, parsed.data));
  });

  return router;
}
