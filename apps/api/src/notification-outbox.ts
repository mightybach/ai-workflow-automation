import { randomUUID } from 'node:crypto';
import type { Prisma } from '@flowpilot/db';
import { BookingNotificationEventSchema, type BookingNotificationEvent } from '@flowpilot/contracts';
import { enrollPreparation } from './workflow-persistence.js';

// Must receive the caller's booking transaction. No root client, network,
// customer input or model capability can publish/deliver through this helper.
export async function enqueueBookingNotification(tx: Prisma.TransactionClient, event: Omit<BookingNotificationEvent, 'eventId' | 'schemaVersion' | 'deliveryMode'>): Promise<void> {
  const value = BookingNotificationEventSchema.parse({ ...event, eventId: randomUUID(), schemaVersion: 1, deliveryMode: 'MOCK' });
  const saved = await tx.notificationOutbox.create({ data: {
    id: value.eventId, schemaVersion: value.schemaVersion, deliveryMode: value.deliveryMode, eventType: value.eventType,
    businessId: value.businessId, bookingId: value.bookingId, previousBookingId: value.previousBookingId,
    occurredAt: new Date(value.occurredAt), availableAt: new Date(value.occurredAt), createdAt: new Date(value.occurredAt), traceId: value.traceId,
  } });
  await enrollPreparation(tx, saved);
}
