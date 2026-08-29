import { z } from 'zod';

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(100),
}).strict();
