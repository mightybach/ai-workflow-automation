import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@flowpilot/db';
import { BookingNotificationEventSchema, OUTBOX_LEASE_MILLISECONDS, OUTBOX_MAX_ATTEMPTS,
  type BookingNotificationEvent, type OutboxPublishErrorCode } from '@flowpilot/contracts';

export class PublishFailure extends Error {
  constructor(public readonly code: OutboxPublishErrorCode) { super(code); }
}
export interface EventPublisher { publish(event: BookingNotificationEvent, signal?: AbortSignal): Promise<void> }
type OutboxRow = Prisma.NotificationOutboxGetPayload<object>;
export type OutboxClaim = { event: BookingNotificationEvent; leaseToken: string; attempts: number };
type ClaimResult = { kind: 'claimed'; claim: OutboxClaim } | { kind: 'dead' } | null;
type Clock = (() => Date) | undefined;
async function referenceTime(tx: Prisma.TransactionClient, clock: Clock) {
  if (clock) return clock();
  const [row] = await tx.$queryRaw<{ now: Date }[]>(Prisma.sql`SELECT clock_timestamp() AS now`);
  return row!.now;
}
export const retryDelayMilliseconds = (attempt: number) => 5000 * 2 ** (attempt - 1);
export function eventFromRow(row: OutboxRow): BookingNotificationEvent {
  return BookingNotificationEventSchema.parse({ eventId: row.id, schemaVersion: row.schemaVersion, deliveryMode: row.deliveryMode,
    eventType: row.eventType, businessId: row.businessId, bookingId: row.bookingId, previousBookingId: row.previousBookingId,
    occurredAt: row.occurredAt.toISOString(), traceId: row.traceId });
}
// Trusted process/test scope only; never supplied by a customer or model.
export async function claimNextEvent(db: PrismaClient, options: { clock?: () => Date; businessId?: string } = {}): Promise<ClaimResult> {
  return db.$transaction(async (tx) => {
    const now = await referenceTime(tx, options.clock);
    const scope = options.businessId ? Prisma.sql`AND "businessId" = ${options.businessId}::uuid` : Prisma.empty;
    const rows = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`SELECT * FROM "NotificationOutbox"
      WHERE status = 'PENDING' AND "deliveryMode" = 'MOCK' AND "schemaVersion" = 1 AND "availableAt" <= ${now}
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now}) ${scope}
      ORDER BY "availableAt", id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    const row = rows[0]; if (!row) return null;
    if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
      await tx.notificationOutbox.update({ where: { id: row.id }, data: { status: 'DEAD', leaseToken: null, leaseExpiresAt: null, lastErrorCode: 'ATTEMPTS_EXHAUSTED' } });
      return { kind: 'dead' };
    }
    const leaseToken = randomUUID();
    await tx.notificationOutbox.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, leaseToken, leaseExpiresAt: new Date(+now + OUTBOX_LEASE_MILLISECONDS) } });
    return { kind: 'claimed', claim: { event: eventFromRow(row), leaseToken, attempts: row.attempts + 1 } };
  }, { isolationLevel: 'ReadCommitted', timeout: 5000 });
}
export async function ownsEventLease(db: PrismaClient, claim: OutboxClaim, clock?: () => Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const now = await referenceTime(tx, clock);
    return await tx.notificationOutbox.count({ where: { id: claim.event.eventId, businessId: claim.event.businessId,
      status: 'PENDING', leaseToken: claim.leaseToken, leaseExpiresAt: { gt: now } } }) === 1;
  });
}
// No network operation in this transaction. Recheck time after the row lock:
// expired/replaced tokens cannot mark another publisher's attempt complete.
export async function finishEventLease(db: PrismaClient, claim: OutboxClaim, errorCode: OutboxPublishErrorCode | null, clock?: () => Date): Promise<'published' | 'retried' | 'dead' | 'lost'> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`SELECT * FROM "NotificationOutbox" WHERE id = ${claim.event.eventId}::uuid
      AND "businessId" = ${claim.event.businessId}::uuid AND status = 'PENDING' AND "leaseToken" = ${claim.leaseToken}::uuid FOR UPDATE`);
    const row = rows[0]; const now = await referenceTime(tx, clock);
    if (!row || !row.leaseExpiresAt || row.leaseExpiresAt <= now) return 'lost';
    const terminal = errorCode !== null && row.attempts >= OUTBOX_MAX_ATTEMPTS;
    await tx.notificationOutbox.update({ where: { id: row.id }, data: {
      status: errorCode === null ? 'PUBLISHED' : terminal ? 'DEAD' : 'PENDING', leaseToken: null, leaseExpiresAt: null,
      publishedAt: errorCode === null ? now : null, lastErrorCode: errorCode,
      ...(errorCode !== null && !terminal ? { availableAt: new Date(+now + retryDelayMilliseconds(row.attempts)) } : {}),
    } });
    return errorCode === null ? 'published' : terminal ? 'dead' : 'retried';
  }, { isolationLevel: 'ReadCommitted', timeout: 5000 });
}
export async function publishOutboxBatch(db: PrismaClient, publisher: EventPublisher, options: { limit?: number; clock?: () => Date; businessId?: string; signal?: AbortSignal } = {}) {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Publisher batch limit must be 1..100.');
  const result = { claimed: 0, published: 0, retried: 0, dead: 0, lost: 0 };
  for (let n = 0; n < limit && !options.signal?.aborted; n++) {
    // Claim only the event about to be sent; a serial batch never pre-leases
    // events whose deadline could expire while earlier messages are in flight.
    const next = await claimNextEvent(db, options);
    if (!next) break;
    if (next.kind === 'dead') { result.dead++; continue; }
    const { claim } = next; result.claimed++;
    if (!await ownsEventLease(db, claim, options.clock)) { result.lost++; continue; }
    let errorCode: OutboxPublishErrorCode | null = null;
    try {
      if (options.signal?.aborted) throw new PublishFailure('PUBLISHER_STOPPED');
      await publisher.publish(claim.event, options.signal);
    } catch (error) { errorCode = error instanceof PublishFailure ? error.code : 'BROKER_UNAVAILABLE'; }
    const outcome = await finishEventLease(db, claim, errorCode, options.clock); result[outcome]++;
  }
  return result;
}
