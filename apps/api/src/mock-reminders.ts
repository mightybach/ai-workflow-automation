import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@flowpilot/db';
import { enqueueBookingNotification } from './notification-outbox.js';

// Trusted maintenance operation; the CLI resolves only the fixed demo slug.
export async function setMockReminderPolicy(db: PrismaClient, businessId: string, enabled: boolean) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${businessId}::uuid FOR UPDATE`);
    const previous = await tx.business.findUniqueOrThrow({ where: { id: businessId } });
    if (previous.mockRemindersEnabled === enabled) return { changed: false };
    await tx.business.update({ where: { id: businessId }, data: { mockRemindersEnabled: enabled } });
    await tx.auditEvent.create({ data: { businessId, entityType: 'Business', entityId: businessId,
      actorType: 'SYSTEM', actorId: null, eventType: 'MOCK_REMINDER_POLICY_CHANGED', traceId: randomUUID(), metadata: { enabled } } });
    return { changed: true };
  });
}

// One fixed 24-hour-window MOCK reminder per booking. No real-recipient policy
// or recurring jobs are inferred. Unique outbox identity makes scans restartable.
export async function scheduleMockReminders(db: PrismaClient, options: { clock?: () => Date; businessId?: string; limit?: number } = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Reminder limit must be 1..100.');
  return db.$transaction(async (tx) => {
    const [time] = options.clock ? [{ now: options.clock() }] : await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const now = time!.now;
    // Serialize one bounded scan per business; do not hold a network transaction.
    const scope = options.businessId ? Prisma.sql`AND b.id = ${options.businessId}::uuid` : Prisma.empty;
    const candidates = await tx.$queryRaw<{ id: string; businessId: string }[]>(Prisma.sql`
      SELECT k.id, k."businessId" FROM "Booking" k JOIN "BookingProposal" p ON p.id = k."proposalId"
      JOIN "Business" b ON b.id = k."businessId"
      WHERE b.active AND b."mockRemindersEnabled" AND k.status = 'CONFIRMED'
        AND p."startAt" > ${now} AND p."startAt" <= ${new Date(+now + 86_400_000)} ${scope}
        AND NOT EXISTS (SELECT 1 FROM "NotificationOutbox" o WHERE o."businessId" = k."businessId" AND o."bookingId" = k.id AND o."eventType" = 'BOOKING_REMINDER')
      ORDER BY p."startAt", k.id LIMIT ${limit}`);
    let enqueued = 0;
    // Stable lock order prevents concurrent multi-business scans deadlocking.
    for (const businessId of [...new Set(candidates.map((row) => row.businessId))].sort()) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${businessId}::uuid FOR UPDATE`);
      const business = await tx.business.findUniqueOrThrow({ where: { id: businessId } });
      if (!business.active || !business.mockRemindersEnabled) continue;
      for (const candidate of candidates.filter((row) => row.businessId === businessId)) {
        // Re-evaluate after waiting: cancellation/rescheduling/another scanner may win.
        const booking = await tx.booking.findFirst({ where: { id: candidate.id, businessId, status: 'CONFIRMED' }, include: { proposal: true } });
        const fresh = options.clock ? options.clock() : (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]!.now;
        if (!booking || booking.proposal.startAt <= fresh || +booking.proposal.startAt - +fresh > 86_400_000) continue;
        if (await tx.notificationOutbox.count({ where: { businessId, bookingId: booking.id, eventType: 'BOOKING_REMINDER' } })) continue;
        await enqueueBookingNotification(tx, { businessId, bookingId: booking.id, eventType: 'BOOKING_REMINDER', previousBookingId: null,
          occurredAt: fresh.toISOString(), traceId: randomUUID() });
        enqueued++;
      }
    }
    return { enqueued };
  }, { timeout: 10_000 });
}
