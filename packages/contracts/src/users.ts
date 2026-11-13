import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { RoleSchema } from './enums.js';

// An allowlisted response DTO, not a serialization of the complete User row.
export const UserResponseSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  role: RoleSchema,
  isActive: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type UserResponse = z.infer<typeof UserResponseSchema>;

