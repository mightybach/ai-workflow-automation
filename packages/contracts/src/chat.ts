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
  provider: z.enum(['mock-v1', 'ollama-v1']),
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
  cancellation: z.object({ key: IdempotencyKeySchema, bookingId: IdSchema }).strict().optional(),
  rescheduling: z.object({
    originalBookingId: IdSchema,
    proposal: z.object({ key: IdempotencyKeySchema, body: CreateBookingProposalBodySchema }).strict().nullable(),
    confirmation: z.object({ key: IdempotencyKeySchema, proposalId: IdSchema }).strict().nullable(),
  }).strict().optional(),
}).strict().refine((value) => !value.cancellation || value.cancellation.bookingId === value.bookingId, 'Cancellation must match the owned booking recovery ID.')
  .refine((value) => !value.rescheduling || value.rescheduling.originalBookingId === value.bookingId && (!value.rescheduling.confirmation || !!value.rescheduling.proposal), 'Rescheduling must match the owned booking and saved selection.')
  .refine((value) => !(value.cancellation && value.rescheduling), 'Resolve one booking change at a time.');
export type BookingPreferences = z.infer<typeof BookingPreferencesSchema>;
export type CustomerChatBody = z.infer<typeof CustomerChatBodySchema>;
export type CustomerChatResponse = z.infer<typeof CustomerChatResponseSchema>;
export type CustomerBookingDraft = z.infer<typeof CustomerBookingDraftSchema>;
