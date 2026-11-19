import { Prisma } from '@flowpilot/db';
import { ApiError } from './errors.js';
export type SavedAppointment = Prisma.BookingGetPayload<{ include: { proposal: true } }>;

// Caller holds the business exclusive lock and scoped booking lock. Shared by
// customer/owner cancellation and atomic replacement; never deletes history.
export async function releaseAppointment(tx: Prisma.TransactionClient, saved: SavedAppointment, clock: () => Date, authorize: (now: Date) => Promise<unknown>): Promise<{ saved: SavedAppointment; now: Date }> {
  const businessId = saved.businessId; const id = saved.id;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Staff" WHERE id = ${saved.proposal.staffId}::uuid AND "businessId" = ${businessId}::uuid FOR SHARE`);
  const person = await tx.staff.findUniqueOrThrow({ where: { id: saved.proposal.staffId } });
  const slots = await tx.$queryRaw<{ id: string; startAt: Date; endAt: Date; state: string }[]>(Prisma.sql`
    SELECT s.id, s."startAt", s."endAt", s.state FROM "AvailabilitySlot" s
    JOIN "BookingSlot" claim ON claim."slotId" = s.id AND claim."businessId" = s."businessId"
    WHERE claim."bookingId" = ${id}::uuid AND claim."businessId" = ${businessId}::uuid AND claim."releasedAt" IS NULL
    ORDER BY s."startAt", s.id FOR UPDATE OF s`);
  const now = clock(); await authorize(now);
  if (saved.proposal.startAt <= now) throw new ApiError(409, 'CANCELLATION_TOO_LATE', 'This appointment has started. Contact the demo operator.');
  if (slots.length !== saved.proposal.durationMinutes / 30 || slots.some((slot) => slot.state !== 'RESERVED')) throw new ApiError(409, 'SLOT_UNAVAILABLE', 'The booking inventory changed. Nothing was changed.');
  const rules = await tx.scheduleClosure.findMany({ where: { businessId, releasedAt: null,
    OR: [{ staffId: null }, { staffId: saved.proposal.staffId }], startAt: { lt: saved.proposal.endAt }, endAt: { gt: saved.proposal.startAt } } });
  const blocked = slots.filter((slot) => !person.active || rules.some((rule) => rule.startAt < slot.endAt && rule.endAt > slot.startAt)).map((slot) => slot.id);
  const blockedIds = new Set(blocked); const available = slots.filter((slot) => !blockedIds.has(slot.id)).map((slot) => slot.id);
  const released = await tx.bookingSlot.updateMany({ where: { bookingId: id, businessId, releasedAt: null }, data: { releasedAt: now } });
  if (released.count !== slots.length) throw new ApiError(409, 'SLOT_UNAVAILABLE', 'The booking inventory changed. Nothing was changed.');
  for (const [ids, state] of [[blocked, 'BLOCKED'], [available, 'AVAILABLE']] as const) {
    if (!ids.length) continue;
    const result = await tx.availabilitySlot.updateMany({ where: { businessId, id: { in: [...ids] }, state: 'RESERVED', bookingSlots: { none: { releasedAt: null } } }, data: { state } });
    if (result.count !== ids.length) throw new ApiError(409, 'SLOT_UNAVAILABLE', 'The full appointment could not be released. Nothing was changed.');
  }
  return { saved: await tx.booking.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: now }, include: { proposal: true } }), now };
}
