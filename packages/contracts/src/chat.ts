import { z } from 'zod';
import { IdSchema, TimestampSchema, IdempotencyKeySchema } from './common.js';
import { BusinessDateSchema, BusinessTimezoneSchema } from './business.js';
import { BookingDurationMinutesSchema, CreateBookingProposalBodySchema, ConfirmBookingBodySchema } from './bookings.js';

export const BookingPreferencesSchema = z.object({
  serviceId: IdSchema.nullable(), staffId: IdSchema.nullable(),
  date: BusinessDateSchema.nullable(), durationMinutes: BookingDurationMinutesSchema.nullable(),
}).strict();
export const CustomerChatBodySchema = z.object({
  message: z.string().trim().min(1).max(1000), context: BookingPreferencesSchema,
}).strict();
export const CustomerChatResponseSchema = z.object({
  provider: z.literal('mock-v1'),
  intent: z.enum(['BOOK_APPOINTMENT', 'VIEW_AVAILABILITY', 'CANCEL_REQUEST', 'UNKNOWN']),
  selection: BookingPreferencesSchema,
  needsClarification: z.array(z.enum(['service', 'staff', 'date', 'duration', 'time', 'request'])).max(6),
  message: z.string().min(1).max(500), referenceTime: TimestampSchema, timezone: BusinessTimezoneSchema,
}).strict();
// Untrusted, tab-scoped recovery data. Restore proposal/booking details from the
// authenticated server; never treat browser storage as consent or confirmation.
export const CustomerBookingDraftSchema = z.object({
  businessId: IdSchema, sessionExpiresAt: TimestampSchema,
  proposal: z.object({ key: IdempotencyKeySchema, body: CreateBookingProposalBodySchema }).strict(),
  confirmation: z.object({ key: IdempotencyKeySchema, body: ConfirmBookingBodySchema }).strict().nullable(),
  bookingId: IdSchema.nullable(),
}).strict();
export type BookingPreferences = z.infer<typeof BookingPreferencesSchema>;
export type CustomerChatBody = z.infer<typeof CustomerChatBodySchema>;
export type CustomerChatResponse = z.infer<typeof CustomerChatResponseSchema>;
export type CustomerBookingDraft = z.infer<typeof CustomerBookingDraftSchema>;
