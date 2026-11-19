import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { BusinessDateSchema, BusinessTimezoneSchema } from './business.js';
import { ScheduleQuerySchema } from './schedule.js';

const windowFields = {
  date: BusinessDateSchema, startMinute: z.number().int().min(0).max(1410).multipleOf(30),
  endMinute: z.number().int().min(30).max(1440).multipleOf(30), expectedUpdatedAt: TimestampSchema,
};
export const AddWorkingTimeSchema = z.object({ ...windowFields, staffId: IdSchema }).strict().refine((value) => value.endMinute > value.startMinute);
export const CreateClosureSchema = z.object({ ...windowFields, staffId: IdSchema.nullable() }).strict().refine((value) => value.endMinute > value.startMinute);
export const ReleaseClosureSchema = z.object({ closureId: IdSchema, expectedUpdatedAt: TimestampSchema }).strict();
export const ScheduleClosureSchema = z.object({
  id: IdSchema, businessId: IdSchema, staffId: IdSchema.nullable(), startAt: TimestampSchema, endAt: TimestampSchema,
  createdAt: TimestampSchema, releasedAt: TimestampSchema.nullable(),
}).strict().refine((value) => Date.parse(value.endAt) > Date.parse(value.startAt));
export const SchedulePolicyQuerySchema = ScheduleQuerySchema;
export const SchedulePolicyResponseSchema = z.object({
  businessId: IdSchema, updatedAt: TimestampSchema, referenceTime: TimestampSchema, timezone: BusinessTimezoneSchema,
  closures: z.array(ScheduleClosureSchema).max(500),
}).strict();
export const SchedulePolicyChangeSchema = z.object({
  businessId: IdSchema, updatedAt: TimestampSchema, createdCount: z.number().int().min(0).max(96),
  blockedCount: z.number().int().min(0).max(500), closure: ScheduleClosureSchema.nullable(),
}).strict();
export type AddWorkingTime = z.infer<typeof AddWorkingTimeSchema>;
export type CreateClosure = z.infer<typeof CreateClosureSchema>;
export type ReleaseClosure = z.infer<typeof ReleaseClosureSchema>;
export type SchedulePolicyResponse = z.infer<typeof SchedulePolicyResponseSchema>;
