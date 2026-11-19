import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, PaginationQuerySchema, PaginationMetaSchema, TimestampSchema } from './common.js';
import { BusinessDateSchema } from './business.js';
import { BookingResponseSchema, BookingStatusSchema } from './bookings.js';
import { ActorTypeSchema } from './enums.js';
export const AdminBookingQuerySchema = PaginationQuerySchema.extend({ date: BusinessDateSchema.optional(), staffId: IdSchema.optional(), status: BookingStatusSchema.optional() }).strict();
export const AdminBookingListSchema = z.object({ items: z.array(BookingResponseSchema).max(50), pagination: PaginationMetaSchema }).strict();
export const AdminAuditQuerySchema = PaginationQuerySchema.extend({ date: BusinessDateSchema.optional(), bookingId: IdSchema.optional() }).strict();
export const AdminAuditListSchema = z.object({ items: z.array(z.object({
  id: IdSchema, entityType: z.string().nullable(), entityId: z.string().nullable(), eventType: z.string(), actorType: ActorTypeSchema, createdAt: TimestampSchema, traceId: z.string(),
}).strict()).max(50), pagination: PaginationMetaSchema }).strict();
export const AdminCancellationResultSchema = z.object({ id: IdSchema, reference: z.string(), status: z.literal('CANCELLED'), cancelledAt: TimestampSchema }).strict();
export const AdminCancellationDraftSchema = z.object({ businessId: IdSchema, actorId: IdSchema, bookingId: IdSchema, key: IdempotencyKeySchema }).strict();
export type AdminCancellationDraft = z.infer<typeof AdminCancellationDraftSchema>;
export type AdminBookingList = z.infer<typeof AdminBookingListSchema>;
export type AdminAuditList = z.infer<typeof AdminAuditListSchema>;
