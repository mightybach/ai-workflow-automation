import { z } from 'zod';
import { UserResponseSchema } from './users.js';

export const LoginBodySchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(200),
}).strict();
export const SessionResponseSchema = z.object({ user: UserResponseSchema }).strict();
export const LogoutResponseSchema = z.object({ ok: z.literal(true) }).strict();

export type LoginBody = z.infer<typeof LoginBodySchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

