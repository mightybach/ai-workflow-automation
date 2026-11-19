import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { AvailabilitySlotSchema, BusinessDateSchema, BusinessTimezoneSchema } from './business.js';

export const ScheduleQuerySchema = z.object({ date: BusinessDateSchema, staffId: IdSchema.optional() }).strict();
export const ScheduleSlotSchema = AvailabilitySlotSchema.safeExtend({
  staffName: z.string().min(1).max(120), staffActive: z.boolean(),
});
export const ScheduleResponseSchema = z.object({
  businessId: IdSchema, date: BusinessDateSchema, timezone: BusinessTimezoneSchema,
  updatedAt: TimestampSchema, referenceTime: TimestampSchema, items: z.array(ScheduleSlotSchema).max(500),
}).strict();
export const ScheduleStateSchema = z.enum(['AVAILABLE', 'BLOCKED']);
export const UpdateScheduleSchema = z.object({
  slotIds: z.array(IdSchema).min(1).max(500).refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, 'Select each slot once.'),
  state: ScheduleStateSchema, expectedUpdatedAt: TimestampSchema,
}).strict();
export const ScheduleChangeResponseSchema = z.object({
  businessId: IdSchema, updatedAt: TimestampSchema, state: ScheduleStateSchema,
  selectedCount: z.number().int().min(1).max(500), changedCount: z.number().int().min(0).max(500),
}).strict().refine((value) => value.changedCount <= value.selectedCount);
export type ScheduleQuery = z.infer<typeof ScheduleQuerySchema>;
export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;
export type UpdateSchedule = z.infer<typeof UpdateScheduleSchema>;
