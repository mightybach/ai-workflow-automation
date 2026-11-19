import { releaseAppointment } from './booking-release.js';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@flowpilot/db';
import { BookingResponseSchema } from '@flowpilot/contracts';
import { customerScope } from './customer-auth.js';
import { bookingDto } from './booking-service.js';
import { ApiError } from './errors.js';

// Called only by the dedicated explicit customer cancellation interaction.
export async function cancelBooking(db: PrismaClient, request: FastifyRequest, bookingId: string, key: string, clock: () => Date) {
  const id = bookingId.toLowerCase();
  const fingerprint = createHash('sha256').update(JSON.stringify(['cancel:v1', id])).digest('hex');
  return db.$transaction(async (tx) => {
    const initial = await customerScope(tx, request, clock());
    const lock = createHash('sha256').update(JSON.stringify([initial.businessId, initial.id, 'CANCEL', key])).digest().readBigInt64BE();
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${lock}::bigint)::text`);
    // Exclusive business lock also serializes closure/settings changes and new
    // confirmations, so releasing all claims cannot race a policy or rebooking.
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${initial.businessId}::uuid FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "CustomerSession" WHERE id = ${initial.id}::uuid AND "businessId" = ${initial.businessId}::uuid FOR SHARE`);
    const session = await customerScope(tx, request, clock());
    const prior = await tx.bookingAction.findUnique({ where: { businessId_sessionId_operation_idempotencyKey: {
      businessId: session.businessId, sessionId: session.id, operation: 'CANCEL', idempotencyKey: key,
    } } });
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used for a different cancellation.');
      return { booking: BookingResponseSchema.parse(prior.response), replayed: true };
    }
    const owned = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Booking" WHERE id = ${id}::uuid
      AND "businessId" = ${session.businessId}::uuid AND "sessionId" = ${session.id}::uuid FOR UPDATE`);
    if (owned.length !== 1) throw new ApiError(404, 'NOT_FOUND', 'Booking not found.');
    let saved = await tx.booking.findUniqueOrThrow({ where: { id }, include: { proposal: true } });
    let now = clock();
    await customerScope(tx, request, now);
    // Already cancelled is a successful no-op, even under a different key or
    // after the original appointment start. Never release a later booking.
    if (saved.status !== 'CANCELLED') {
      const released = await releaseAppointment(tx, saved, clock, (time) => customerScope(tx, request, time));
      saved = released.saved; now = released.now;
      await tx.business.update({ where: { id: session.businessId }, data: { updatedAt: new Date(Math.max(+now, +session.business.updatedAt + 1)) } });
      await tx.auditEvent.create({ data: { businessId: session.businessId, entityType: 'Booking', entityId: id,
        actorType: 'SYSTEM', actorId: null, eventType: 'BOOKING_CANCELLED', traceId: request.id,
        metadata: { durationMinutes: saved.proposal.durationMinutes }, createdAt: now } });
    }
    const booking = bookingDto(saved);
    await tx.bookingAction.create({ data: { businessId: session.businessId, sessionId: session.id, operation: 'CANCEL',
      idempotencyKey: key, requestFingerprint: fingerprint, proposalId: saved.proposalId, bookingId: id, response: booking, createdAt: now } });
    return { booking, replayed: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 10000 });
}
