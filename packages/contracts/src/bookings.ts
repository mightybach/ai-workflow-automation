import { z } from 'zod';
import { IdSchema, TimestampSchema, PaginationQuerySchema, PaginationMetaSchema, ApiErrorSchema } from './common.js';
import { BusinessDateSchema, BusinessTimezoneSchema } from './business.js';

// Policy defaults for the local demo, enforced by future server code using its clock.
export const CUSTOMER_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const BOOKING_PROPOSAL_TTL_SECONDS = 5 * 60;
// 24 hours is the technical ceiling; the current business limit is authoritative.
export const BookingDurationMinutesSchema = z.number().int().min(30).max(1440).multipleOf(30);
const durationQuery = z.union([z.number(), z.string().regex(/^[1-9][0-9]*$/)])
  .transform(Number).pipe(BookingDurationMinutesSchema);

export const CreateCustomerSessionBodySchema = z.object({
  businessSlug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
}).strict();
// The opaque token belongs only in an HttpOnly cookie, never this DTO.
export const CustomerSessionResponseSchema = z.object({
  businessId: IdSchema, businessName: z.string().min(1).max(160),
  timezone: BusinessTimezoneSchema, today: BusinessDateSchema,
  maxBookingDurationMinutes: BookingDurationMinutesSchema, expiresAt: TimestampSchema,
}).strict();
export const CustomerCatalogQuerySchema = PaginationQuerySchema;
export const CustomerAvailabilityQuerySchema = PaginationQuerySchema.extend({
  date: BusinessDateSchema, serviceId: IdSchema, staffId: IdSchema.optional(), durationMinutes: durationQuery,
  rescheduleBookingId: IdSchema.optional(),
}).strict();

const AppointmentSelectionSchema = z.object({
  businessId: IdSchema, slotId: IdSchema, serviceId: IdSchema, staffId: IdSchema,
  durationMinutes: BookingDurationMinutesSchema,
  serviceName: z.string().trim().min(1).max(160),
  staffName: z.string().trim().min(1).max(120),
  startAt: TimestampSchema, endAt: TimestampSchema, timezone: BusinessTimezoneSchema,
}).strict();
const fixedSlot = (slot: { startAt: string; endAt: string; durationMinutes: number }) =>
  Date.parse(slot.endAt) - Date.parse(slot.startAt) === slot.durationMinutes * 60 * 1000 &&
  Date.parse(slot.startAt) % (30 * 60 * 1000) === 0;

export const CustomerAvailableSlotSchema = AppointmentSelectionSchema.refine(fixedSlot, 'Use an aligned appointment matching its duration.');
export const CustomerAvailabilityResponseSchema = z.object({
  items: z.array(CustomerAvailableSlotSchema).max(50), pagination: PaginationMetaSchema,
  date: BusinessDateSchema, timezone: BusinessTimezoneSchema, asOf: TimestampSchema,
}).strict();
export const CreateBookingProposalBodySchema = z.object({
  slotId: IdSchema, serviceId: IdSchema, durationMinutes: BookingDurationMinutesSchema,
}).strict();
export const BookingProposalResponseSchema = AppointmentSelectionSchema.extend({
  id: IdSchema, createdAt: TimestampSchema, expiresAt: TimestampSchema,
  rescheduleOfId: IdSchema.nullable().default(null),
}).strict().refine(fixedSlot, 'Use an aligned appointment matching its duration.')
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.createdAt), 'Expiry must follow creation.');

export const SyntheticCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase())
    .refine((value) => value.endsWith('@example.test'), 'Use a synthetic example.test address.'),
}).strict();
// Only the dedicated confirmation interaction submits this body. It contains
// no model-controlled consent/status field and cannot replace the saved selection.
export const ConfirmBookingBodySchema = z.object({
  proposalId: IdSchema, customer: SyntheticCustomerSchema,
}).strict();
export const CancelBookingBodySchema = z.object({}).strict();
export const RescheduleBookingBodySchema = z.object({ proposalId: IdSchema }).strict();
export const BookingStatusSchema = z.enum(['CONFIRMED', 'CANCELLED']);
export const BookingResponseSchema = AppointmentSelectionSchema.extend({
  id: IdSchema, reference: z.string().min(1).max(64).regex(/^[A-Z0-9-]+$/),
  status: BookingStatusSchema, customer: SyntheticCustomerSchema, createdAt: TimestampSchema,
  // Older persisted confirmation snapshots omitted this field.
  cancelledAt: TimestampSchema.nullable().default(null),
  rescheduledFromId: IdSchema.nullable().default(null),
}).strict().refine(fixedSlot, 'Use an aligned appointment matching its duration.')
  .refine((value) => value.status === 'CANCELLED' ? value.cancelledAt !== null : value.cancelledAt === null, 'Cancellation requires its server timestamp.');

export const BookingErrorCodeSchema = z.enum([
  'VALIDATION_ERROR', 'UNAUTHENTICATED', 'NOT_FOUND', 'PROPOSAL_EXPIRED',
  'PROPOSAL_ALREADY_USED', 'SLOT_UNAVAILABLE', 'SELECTION_UNAVAILABLE',
  'DURATION_NOT_ALLOWED', 'IDEMPOTENCY_CONFLICT', 'RATE_LIMITED', 'INTERNAL_ERROR', 'CANCELLATION_TOO_LATE', 'BOOKING_NOT_CHANGEABLE',
]);
export const BookingErrorResponseSchema = ApiErrorSchema.extend({ code: BookingErrorCodeSchema }).strict();

export type CreateCustomerSessionBody = z.infer<typeof CreateCustomerSessionBodySchema>;
export type CustomerSessionResponse = z.infer<typeof CustomerSessionResponseSchema>;
export type CustomerCatalogQuery = z.infer<typeof CustomerCatalogQuerySchema>;
export type CustomerAvailabilityQueryInput = z.input<typeof CustomerAvailabilityQuerySchema>;
export type CustomerAvailabilityQuery = z.infer<typeof CustomerAvailabilityQuerySchema>;
export type CustomerAvailabilityResponse = z.infer<typeof CustomerAvailabilityResponseSchema>;
export type CreateBookingProposalBody = z.infer<typeof CreateBookingProposalBodySchema>;
export type BookingProposalResponse = z.infer<typeof BookingProposalResponseSchema>;
export type ConfirmBookingBody = z.infer<typeof ConfirmBookingBodySchema>;
export type CancelBookingBody = z.infer<typeof CancelBookingBodySchema>;
export type BookingResponse = z.infer<typeof BookingResponseSchema>;
export type BookingStatus = z.infer<typeof BookingStatusSchema>;
export type BookingErrorResponse = z.infer<typeof BookingErrorResponseSchema>;
