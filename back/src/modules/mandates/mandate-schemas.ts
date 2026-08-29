import { z } from 'zod';

import { authorizationSpecificationSchema } from '../purchase-intents/specifications.js';

export const createMandateDraftSchema = z.object({
  mode: z.enum(['HUMAN_PRESENT', 'AUTONOMOUS']).default('AUTONOMOUS'),
}).strict();

export const createMandateVersionSchema = z.object({
  authorizationSpecification: authorizationSpecificationSchema,
}).strict();

export const revokeMandateSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();
