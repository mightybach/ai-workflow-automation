import { BookingNotificationEventSchema } from '@flowpilot/contracts';
import { Prisma, type PrismaClient } from '@flowpilot/db';
import { eventFromRow } from './outbox-publisher.js';

export class InvalidNotification extends Error {
  constructor() { super('INVALID_NOTIFICATION'); }
}
// Messages are hints to read trusted persistence, never commands or consent.
export async function processMockNotification(db: PrismaClient, input: unknown, clock?: () => Date) {
  const parsed = BookingNotificationEventSchema.safeParse(input);
  if (!parsed.success) throw new InvalidNotification();
  const event = parsed.data;
  return db.$transaction(async (tx) => {
    // Same lock order as booking writes: business before event/booking.
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${event.businessId}::uuid FOR SHARE`);
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "NotificationOutbox"
      WHERE id = ${event.eventId}::uuid AND "businessId" = ${event.businessId}::uuid FOR UPDATE`);
    if (!rows.length) throw new InvalidNotification();
    const saved = await tx.notificationOutbox.findUniqueOrThrow({ where: { id: event.eventId } });
    const trusted = eventFromRow(saved);
    if (Object.keys(trusted).some((key) => trusted[key as keyof typeof trusted] !== event[key as keyof typeof event])) throw new InvalidNotification();
    // Broker delivery can arrive before the publisher commits PUBLISHED.
    // Even DEAD can have reached the broker before its confirmation was lost.
    if (saved.attempts < 1) throw new InvalidNotification();
    const prior = await tx.mockNotificationReceipt.findUnique({ where: { eventId: saved.id } });
    if (prior) return { ...prior, duplicate: true };
    const business = await tx.business.findUniqueOrThrow({ where: { id: saved.businessId } });
    const booking = await tx.booking.findFirstOrThrow({ where: { id: saved.bookingId, businessId: saved.businessId }, include: { proposal: true } });
    const [time] = clock ? [{ now: clock() }] : await tx.$queryRaw<{ now: Date }[]>(Prisma.sql`SELECT clock_timestamp() AS now`);
    let current = saved.eventType === 'BOOKING_CANCELLED' ? booking.status === 'CANCELLED' : booking.status === 'CONFIRMED';
    current = current && booking.proposal.startAt > time!.now;
    if (saved.eventType === 'BOOKING_RESCHEDULED') {
      const previous = await tx.booking.findFirst({ where: { id: saved.previousBookingId!, businessId: saved.businessId, status: 'CANCELLED' } });
      current = current && previous !== null && booking.proposal.rescheduleOfId === saved.previousBookingId;
    }
    if (saved.eventType === 'BOOKING_REMINDER') current = current && +booking.proposal.startAt - +time!.now <= 86_400_000;
    const reason = !business.active ? 'INACTIVE_BUSINESS' : saved.eventType === 'BOOKING_REMINDER' && !business.mockRemindersEnabled
      ? 'REMINDERS_DISABLED' : current ? 'CURRENT_BOOKING' : 'STALE_BOOKING';
    const receipt = await tx.mockNotificationReceipt.create({ data: { eventId: saved.id,
      outcome: reason === 'CURRENT_BOOKING' ? 'MOCK_DELIVERED' : 'SUPPRESSED', reason, processedAt: time!.now } });
    return { ...receipt, duplicate: false };
  }, { timeout: 5000 });
}
