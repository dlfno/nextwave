import { z } from 'zod';

export const createPurchaseIntentSchema = z.object({
  agentId: z.uuid(),
  originalRequest: z.string().trim().min(1).max(2_000),
}).strict();

export const addIntentMessageSchema = z.object({
  content: z.string().trim().min(1).max(2_000),
}).strict();

export type CreatePurchaseIntentInput = z.infer<typeof createPurchaseIntentSchema>;
