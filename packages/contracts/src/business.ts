import { z } from 'zod';
import { IdSchema, TimestampSchema, PaginationQuerySchema, PaginationMetaSchema } from './common.js';

export const BusinessRoleSchema = z.enum(['OWNER', 'STAFF']);
export const SlotStateSchema = z.enum(['AVAILABLE', 'RESERVED', 'BLOCKED']);
export const BusinessTimezoneSchema = z.string().min(1).max(100).refine((zone) => {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}, 'Use an IANA time zone.');
export const BusinessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '2000-01-01' && value <= '2100-12-31';
}, 'Use a valid calendar date between 2000 and 2100.');
export const BusinessSchema = z.object({
  id: IdSchema, name: z.string().min(1).max(160), timezone: BusinessTimezoneSchema, active: z.boolean(),
}).strict();
export const BusinessSetupResponseSchema = z.object({
  business: BusinessSchema,
  membership: z.object({ role: BusinessRoleSchema }).strict(),
  today: BusinessDateSchema,
}).strict();
export const StaffResponseSchema = z.object({
  id: IdSchema, businessId: IdSchema, displayName: z.string().min(1).max(120), active: z.boolean(),
}).strict();
export const ServiceResponseSchema = z.object({
  id: IdSchema, businessId: IdSchema, name: z.string().min(1).max(160),
  durationMinutes: z.literal(30), active: z.boolean(),
}).strict();
export const StaffListResponseSchema = z.object({ items: z.array(StaffResponseSchema), pagination: PaginationMetaSchema }).strict();
export const ServiceListResponseSchema = z.object({ items: z.array(ServiceResponseSchema), pagination: PaginationMetaSchema }).strict();
export const AdminListQuerySchema = PaginationQuerySchema;
export const AdminSlotQuerySchema = PaginationQuerySchema.extend({
  date: BusinessDateSchema, staffId: IdSchema.optional(), state: SlotStateSchema.optional(),
}).strict();
export const AvailabilitySlotSchema = z.object({
  id: IdSchema, businessId: IdSchema, staffId: IdSchema,
  startAt: TimestampSchema, endAt: TimestampSchema, state: SlotStateSchema,
}).strict().refine((slot) => Date.parse(slot.endAt) - Date.parse(slot.startAt) === 30 * 60 * 1000, 'Slots must last 30 minutes.');
export const AdminSlotListResponseSchema = z.object({
  items: z.array(AvailabilitySlotSchema).max(50), pagination: PaginationMetaSchema, date: BusinessDateSchema, timezone: BusinessTimezoneSchema,
}).strict();

export type BusinessRole = z.infer<typeof BusinessRoleSchema>;
export type BusinessSetupResponse = z.infer<typeof BusinessSetupResponseSchema>;
export type StaffListResponse = z.infer<typeof StaffListResponseSchema>;
export type ServiceListResponse = z.infer<typeof ServiceListResponseSchema>;
export type AdminSlotListResponse = z.infer<typeof AdminSlotListResponseSchema>;

