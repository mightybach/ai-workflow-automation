import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@flowpilot/db';
import { BookingResponseSchema } from '@flowpilot/contracts';
import { customerScope } from './customer-auth.js';
import { bookingDto } from './booking-service.js';
import { releaseAppointment } from './booking-release.js';
import { ApiError } from './errors.js';
import { enqueueBookingNotification } from './notification-outbox.js';

export async function rescheduleBooking(db: PrismaClient, request: FastifyRequest, originalId: string, proposalId: string, key: string, clock: () => Date) {
  const id = originalId.toLowerCase(); const selectionId = proposalId.toLowerCase();
  const fingerprint = createHash('sha256').update(JSON.stringify(['reschedule:v1', id, selectionId])).digest('hex');
  return db.$transaction(async (tx) => {
    const initial = await customerScope(tx, request, clock());
    const lock = createHash('sha256').update(JSON.stringify([initial.businessId, initial.id, 'RESCHEDULE', key])).digest().readBigInt64BE();
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${lock}::bigint)::text`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${initial.businessId}::uuid FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "CustomerSession" WHERE id = ${initial.id}::uuid FOR SHARE`);
    const session = await customerScope(tx, request, clock());
    const previous = await tx.bookingAction.findUnique({ where: { businessId_sessionId_operation_idempotencyKey: { businessId: session.businessId, sessionId: session.id, operation: 'RESCHEDULE', idempotencyKey: key } } });
    if (previous) {
      if (previous.requestFingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different rescheduling.');
      return { booking: BookingResponseSchema.parse(previous.response), replayed: true };
    }
    const owned = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Booking" WHERE id = ${id}::uuid AND "businessId" = ${session.businessId}::uuid AND "sessionId" = ${session.id}::uuid FOR UPDATE`);
    if (owned.length !== 1) throw new ApiError(404, 'NOT_FOUND', 'Booking not found.');
    const original = await tx.booking.findUniqueOrThrow({ where: { id }, include: { proposal: true } });
    if (original.status !== 'CONFIRMED') throw new ApiError(409, 'BOOKING_NOT_CHANGEABLE', 'This booking has already changed. Refresh the current appointment.');
    const proposals = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "BookingProposal" WHERE id = ${selectionId}::uuid AND "businessId" = ${session.businessId}::uuid AND "sessionId" = ${session.id}::uuid AND "rescheduleOfId" = ${id}::uuid FOR UPDATE`);
    if (proposals.length !== 1) throw new ApiError(404, 'NOT_FOUND', 'Rescheduling proposal not found.');
    const selection = await tx.bookingProposal.findUniqueOrThrow({ where: { id: selectionId }, include: { booking: true } });
    if (selection.booking) throw new ApiError(409, 'PROPOSAL_ALREADY_USED', 'This proposal already created an appointment.');
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Staff" WHERE id = ${selection.staffId}::uuid AND "businessId" = ${session.businessId}::uuid FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Service" WHERE id = ${selection.serviceId}::uuid AND "businessId" = ${session.businessId}::uuid FOR SHARE`);
    if (!await tx.staff.findFirst({ where: { id: selection.staffId, businessId: session.businessId, active: true } }) ||
        !await tx.service.findFirst({ where: { id: selection.serviceId, businessId: session.businessId, active: true } }) || selection.timezone !== session.business.timezone) throw new ApiError(409, 'SELECTION_UNAVAILABLE', 'The business setup changed. Choose again.');
    if (selection.durationMinutes > session.business.maxBookingDurationMinutes) throw new ApiError(409, 'DURATION_NOT_ALLOWED', 'The new appointment exceeds the business maximum.');
    const parts = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "AvailabilitySlot" WHERE "businessId" = ${session.businessId}::uuid AND "staffId" = ${selection.staffId}::uuid AND "startAt" >= ${selection.startAt} AND "startAt" < ${selection.endAt} ORDER BY "startAt", id FOR UPDATE`);
    let now = clock(); await customerScope(tx, request, now);
    if (selection.expiresAt <= now) throw new ApiError(409, 'PROPOSAL_EXPIRED', 'Review a fresh replacement proposal.');
    if (selection.startAt <= now) throw new ApiError(409, 'SLOT_UNAVAILABLE', 'Choose a future appointment.');
    // Release and replacement claim are inside this same transaction. Any
    // failure (including audit/constraint failure) restores the entire original.
    await releaseAppointment(tx, original, clock, (time) => customerScope(tx, request, time));
    now = clock(); await customerScope(tx, request, now);
    if (selection.expiresAt <= now) throw new ApiError(409, 'PROPOSAL_EXPIRED', 'Review a fresh replacement proposal. Your original appointment was kept.');
    if (selection.startAt <= now) throw new ApiError(409, 'SLOT_UNAVAILABLE', 'Choose a future replacement. Your original appointment was kept.');
    const expected = selection.durationMinutes / 30;
    const claimed = await tx.availabilitySlot.updateMany({ where: { businessId: session.businessId, id: { in: parts.map((part) => part.id) }, state: 'AVAILABLE', bookingSlots: { none: { releasedAt: null } } }, data: { state: 'RESERVED' } });
    if (parts.length !== expected || claimed.count !== expected) throw new ApiError(409, 'SLOT_UNAVAILABLE', 'The replacement is unavailable. Your original appointment was kept.');
    const saved = await tx.booking.create({ data: { businessId: session.businessId, sessionId: session.id, proposalId: selection.id,
      reference: 'FP-' + randomUUID().replaceAll('-', '').toUpperCase(), customerName: original.customerName, customerEmail: original.customerEmail, createdAt: now }, include: { proposal: true } });
    await tx.bookingSlot.createMany({ data: parts.map((part) => ({ businessId: session.businessId, bookingId: saved.id, staffId: selection.staffId, slotId: part.id })) });
    const booking = bookingDto(saved);
    await tx.bookingAction.create({ data: { businessId: session.businessId, sessionId: session.id, operation: 'RESCHEDULE', idempotencyKey: key, requestFingerprint: fingerprint, proposalId: selection.id, bookingId: saved.id, response: booking, createdAt: now } });
    await tx.business.update({ where: { id: session.businessId }, data: { updatedAt: new Date(Math.max(+now, +session.business.updatedAt + 1)) } });
    await tx.auditEvent.create({ data: { businessId: session.businessId, entityType: 'Booking', entityId: saved.id, actorType: 'SYSTEM', actorId: null, eventType: 'BOOKING_RESCHEDULED', traceId: request.id, metadata: { previousBookingId: id, durationMinutes: selection.durationMinutes }, createdAt: now } });
    await tx.auditEvent.create({ data: { businessId: session.businessId, entityType: 'Booking', entityId: id, actorType: 'SYSTEM', actorId: null, eventType: 'BOOKING_REPLACED', traceId: request.id, metadata: { replacementBookingId: saved.id }, createdAt: now } });
    await enqueueBookingNotification(tx, { eventType: 'BOOKING_RESCHEDULED', businessId: saved.businessId, bookingId: saved.id, previousBookingId: id, occurredAt: now.toISOString(), traceId: request.id });
    return { booking, replayed: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 10000 });
}
