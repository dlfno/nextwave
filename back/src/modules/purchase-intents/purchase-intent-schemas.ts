import { z } from 'zod';

const ianaTimeZone = z.string().trim().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}, 'Invalid IANA timezone');

export const purchaseClientContextSchema = z.object({
  timeZone: ianaTimeZone,
  locale: z.string().trim().min(1).max(35),
  observedAt: z.iso.datetime(),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().nonnegative().max(100_000),
  }).strict().optional(),
}).strict();

export const createPurchaseIntentSchema = z.object({
  agentId: z.uuid(),
  originalRequest: z.string().trim().min(1).max(2_000),
  clientContext: purchaseClientContextSchema.optional(),
}).strict();

export const addIntentMessageSchema = z.object({
  content: z.string().trim().min(1).max(2_000),
}).strict();

export type CreatePurchaseIntentInput = z.infer<typeof createPurchaseIntentSchema>;
export type PurchaseClientContext = z.infer<typeof purchaseClientContextSchema>;
