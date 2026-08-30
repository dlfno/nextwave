import { Router } from 'express';
import { z } from 'zod';

import type { DatabaseClient } from '../../database/client.js';
import { validateBody } from '../../http/validate.js';
import { HttpError } from '../../shared/http-error.js';
import { authenticate, requireCsrf } from '../auth/session.js';
import { RecordsService } from './records-service.js';

const uuidSchema = z.uuid();
const disputeSchema = z.object({
  reasonCode: z.string().min(1).max(100),
  statement: z.string().min(1).max(2000).optional(),
}).strict();
const resolutionSchema = z.object({
  status: z.enum(['RESOLVED_USER', 'RESOLVED_MERCHANT', 'CLOSED']),
  summary: z.string().min(1).max(2000),
}).strict();

function uuid(value: unknown, code: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(404, code, 'Resource not found');
  return parsed.data;
}

function requireRole(role: string, allowed: readonly string[]): void {
  if (!allowed.includes(role)) throw new HttpError(403, 'ROLE_REQUIRED', 'Required role is missing');
}

export function createRecordsRouter(database: DatabaseClient): Router {
  const router = Router();
  const service = new RecordsService(database);
  router.use(authenticate(database));

  router.get('/transactions', async (request, response) => {
    response.json({ transactions: await service.listTransactions(request.auth!.user.id) });
  });
  router.get('/transactions/:transactionId', async (request, response) => {
    response.json(await service.transactionDetail(request.auth!.user.id,
      uuid(request.params.transactionId, 'TRANSACTION_NOT_FOUND')));
  });
  router.get('/transactions/:transactionId/receipt', async (request, response) => {
    response.json({ receipt: await service.receiptForUser(request.auth!.user.id,
      uuid(request.params.transactionId, 'TRANSACTION_NOT_FOUND')) });
  });
  router.get('/transactions/:transactionId/audit', async (request, response) => {
    response.json(await service.humanAudit(request.auth!.user.id,
      uuid(request.params.transactionId, 'TRANSACTION_NOT_FOUND')));
  });
  router.get('/merchant/verifications/:attemptId', async (request, response) => {
    requireRole(request.auth!.user.role, ['MERCHANT_OPERATOR', 'ADMIN']);
    response.json(await service.merchantVerification(uuid(request.params.attemptId, 'PURCHASE_ATTEMPT_NOT_FOUND')));
  });
  router.get('/auditor/transactions/:transactionId/evidence', async (request, response) => {
    requireRole(request.auth!.user.role, ['AUDITOR', 'ADMIN']);
    response.json(await service.auditorEvidence(uuid(request.params.transactionId, 'TRANSACTION_NOT_FOUND')));
  });
  router.post('/transactions/:transactionId/disputes', requireCsrf,
    validateBody(disputeSchema), async (request, response) => {
      response.status(201).json(await service.openDispute(
        request.auth!.user.id,
        uuid(request.params.transactionId, 'TRANSACTION_NOT_FOUND'),
        request.body.reasonCode,
        request.body.statement,
      ));
    });
  router.get('/disputes/:disputeId', async (request, response) => {
    response.json(await service.getDispute(
      request.auth!.user.id,
      request.auth!.user.role,
      uuid(request.params.disputeId, 'DISPUTE_NOT_FOUND'),
    ));
  });
  router.post('/disputes/:disputeId/resolve', requireCsrf,
    validateBody(resolutionSchema), async (request, response) => {
      requireRole(request.auth!.user.role, ['AUDITOR', 'ADMIN']);
      response.json({ dispute: await service.resolveDispute(
        request.auth!.user.id,
        uuid(request.params.disputeId, 'DISPUTE_NOT_FOUND'),
        request.body.status,
        request.body.summary,
      ) });
    });
  return router;
}
