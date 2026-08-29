import { z } from 'zod';

const email = z.string().trim().email().max(320).transform((value) => value.toLowerCase());
const password = z.string().min(12).max(128);

export const registerSchema = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(100),
}).strict();

export const loginSchema = z.object({
  email,
  password,
}).strict();

export const reauthenticateSchema = z.object({ password }).strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
