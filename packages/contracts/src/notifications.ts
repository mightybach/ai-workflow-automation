import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';

// Internal event contract, never a customer/model-controlled command. Version
// and persisted MOCK policy must be verified again by any future consumer.
export const NOTIFICATION_EVENT_VERSION = 1;
export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_LEASE_MILLISECONDS = 30_000;
export const MOCK_NOTIFICATION_QUEUE = 'flowpilot.mock.notifications.v1';
export const MOCK_NOTIFICATION_MAX_DELIVERIES = 5;
export const MockNotificationRejectionReasonSchema = z.enum(['INVALID_NOTIFICATION', 'PROCESSING_EXHAUSTED']);
export const OutboxPublishErrorCodeSchema = z.enum(['BROKER_UNAVAILABLE', 'BROKER_TIMEOUT', 'BROKER_NACK', 'UNROUTABLE', 'INVALID_EVENT', 'PUBLISHER_STOPPED', 'ATTEMPTS_EXHAUSTED']);
export const NotificationEventTypeSchema = z.enum(['BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'BOOKING_RESCHEDULED', 'BOOKING_REMINDER']);
export const NotificationDeliveryModeSchema = z.literal('MOCK');
export const OutboxStatusSchema = z.enum(['PENDING', 'PUBLISHED', 'DEAD']);
export const MockNotificationOutcomeSchema = z.enum(['MOCK_DELIVERED', 'SUPPRESSED']);
export const MockNotificationReasonSchema = z.enum(['CURRENT_BOOKING', 'STALE_BOOKING', 'INACTIVE_BUSINESS', 'REMINDERS_DISABLED']);
export const BookingNotificationEventSchema = z.object({
  eventId: IdSchema, schemaVersion: z.literal(NOTIFICATION_EVENT_VERSION),
  eventType: NotificationEventTypeSchema, deliveryMode: NotificationDeliveryModeSchema,
  businessId: IdSchema, bookingId: IdSchema, previousBookingId: IdSchema.nullable(),
  occurredAt: TimestampSchema, traceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9-]+$/),
}).strict().refine((event) => event.eventType === 'BOOKING_RESCHEDULED'
  ? event.previousBookingId !== null && event.previousBookingId !== event.bookingId
  : event.previousBookingId === null, 'Only rescheduling has a different previous booking.');
export type BookingNotificationEvent = z.infer<typeof BookingNotificationEventSchema>;
export type NotificationEventType = z.infer<typeof NotificationEventTypeSchema>;
export type OutboxPublishErrorCode = z.infer<typeof OutboxPublishErrorCodeSchema>;
