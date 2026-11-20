import { createHash } from 'node:crypto';
import type { GetMessage } from 'amqplib';
import type { PrismaClient } from '@flowpilot/db';
import { MOCK_NOTIFICATION_MAX_DELIVERIES, MockNotificationRejectionReasonSchema } from '@flowpilot/contracts';
import { InvalidNotification, processMockNotification } from './notification-worker.js';

export async function quarantineNotification(db: PrismaClient, message: GetMessage, reason: 'INVALID_NOTIFICATION' | 'PROCESSING_EXHAUSTED') {
  MockNotificationRejectionReasonSchema.parse(reason);
  const fingerprint = createHash('sha256').update(reason).update('\0').update(String(message.properties.messageId ?? '')).update('\0').update(message.content).digest('hex');
  // ON CONFLICT DO NOTHING keeps repeated poison deliveries immutable.
  await db.mockNotificationRejection.createMany({ data: [{ fingerprint, reason }], skipDuplicates: true });
  return { outcome: 'QUARANTINED' as const, reason };
}
export async function handleNotificationDelivery(db: PrismaClient, message: GetMessage) {
  try {
    if (message.content.length > 4096 || message.properties.contentType !== 'application/json') throw new InvalidNotification();
    let input: unknown;
    try { input = JSON.parse(message.content.toString('utf8')); } catch { throw new InvalidNotification(); }
    if (!input || typeof input !== 'object' || !('eventId' in input) || message.properties.messageId !== input.eventId) throw new InvalidNotification();
    return await processMockNotification(db, input);
  } catch (error) {
    if (error instanceof InvalidNotification) return quarantineNotification(db, message, 'INVALID_NOTIFICATION');
    // This counter is maintained by the quorum broker, not model/customer text.
    const count: unknown = message.properties.headers?.['x-delivery-count'];
    if (typeof count === 'number' && Number.isInteger(count) && count >= MOCK_NOTIFICATION_MAX_DELIVERIES - 1) {
      return quarantineNotification(db, message, 'PROCESSING_EXHAUSTED');
    }
    throw error; // No ACK if persistence (including quarantine) is unavailable.
  }
}
