import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@flowpilot/db';
import { BookingResponseSchema, type ConfirmBookingBody } from '@flowpilot/contracts';
import { customerScope } from './customer-auth.js';
import { ApiError } from './errors.js';

type SavedBooking = Prisma.BookingGetPayload<{ include: { proposal: true } }>;
export function bookingDto(booking: SavedBooking) {
  const proposal = booking.proposal;
  return BookingResponseSchema.parse({
    id: booking.id, businessId: booking.businessId, reference: booking.reference, status: booking.status,
    slotId: proposal.slotId, serviceId: proposal.serviceId, staffId: proposal.staffId,
    serviceName: proposal.serviceName, staffName: proposal.staffName, durationMinutes: proposal.durationMinutes,
    startAt: proposal.startAt.toISOString(), endAt: proposal.endAt.toISOString(), timezone: proposal.timezone,
    customer: { name: booking.customerName, email: booking.customerEmail }, createdAt: booking.createdAt.toISOString(),
  });
}

// Only the dedicated customer-confirmation route calls this write operation.
// Future model extraction/orchestration must not receive it as an executable tool.
export async function confirmBooking(
  db: PrismaClient, request: FastifyRequest, body: ConfirmBookingBody, idempotencyKey: string, clock: () => Date,
) {
  const proposalId = body.proposalId.toLowerCase();
  const customer = { name: body.customer.name.trim(), email: body.customer.email.trim().toLowerCase() };
  const fingerprint = createHash('sha256').update(JSON.stringify(['confirm:v1', proposalId, customer.name, customer.email])).digest('hex');
  return db.$transaction(async (tx) => {
    const initial = await customerScope(tx, request, clock());
    const lock = createHash('sha256').update(JSON.stringify([initial.businessId, initial.id, 'CONFIRM', idempotencyKey])).digest().readBigInt64BE();
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${lock}::bigint)::text`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${initial.businessId}::uuid FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "CustomerSession" WHERE id = ${initial.id}::uuid AND "businessId" = ${initial.businessId}::uuid FOR SHARE`);
    const session = await customerScope(tx, request, clock());
    const action = await tx.bookingAction.findUnique({ where: {
      businessId_sessionId_operation_idempotencyKey: {
        businessId: session.businessId, sessionId: session.id, operation: 'CONFIRM', idempotencyKey,
      },
    } });
    if (action) {
      if (action.requestFingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used for a different confirmation.');
      return { booking: BookingResponseSchema.parse(action.response), replayed: true };
    }
    // Serialize different keys consuming the same proposal, scoped before locking.
    const owned = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM "BookingProposal" WHERE id = ${proposalId}::uuid
        AND "businessId" = ${session.businessId}::uuid AND "sessionId" = ${session.id}::uuid FOR UPDATE`);
    if (owned.length !== 1) throw new ApiError(404, 'NOT_FOUND', 'Proposal not found.');
    const proposal = await tx.bookingProposal.findUniqueOrThrow({ where: { id: proposalId }, include: { booking: true } });
    if (proposal.booking) throw new ApiError(409, 'PROPOSAL_ALREADY_USED', 'This proposal already created an appointment.');
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Service" WHERE id = ${proposal.serviceId}::uuid AND "businessId" = ${session.businessId}::uuid FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Staff" WHERE id = ${proposal.staffId}::uuid AND "businessId" = ${session.businessId}::uuid FOR SHARE`);
    const service = await tx.service.findFirst({ where: { id: proposal.serviceId, businessId: session.businessId, active: true } });
    const staff = await tx.staff.findFirst({ where: { id: proposal.staffId, businessId: session.businessId, active: true } });
    if (!service || !staff || proposal.timezone !== session.business.timezone) {
      throw new ApiError(409, 'SELECTION_UNAVAILABLE', 'The selected business setup changed. Choose again.');
    }
    if (proposal.durationMinutes > session.business.maxBookingDurationMinutes) {
      throw new ApiError(409, 'DURATION_NOT_ALLOWED', 'The appointment exceeds the current business maximum.');
    }
    // Deterministic row-lock order prevents opposing overlapping intervals from
    // acquiring base-slot locks in different orders. Claims remain conditional.
    const slots = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM "AvailabilitySlot" WHERE "businessId" = ${session.businessId}::uuid
        AND "staffId" = ${proposal.staffId}::uuid AND "startAt" >= ${proposal.startAt}
        AND "startAt" < ${proposal.endAt} ORDER BY "startAt", id FOR UPDATE`);
    const now = clock();
    await customerScope(tx, request, now);
    if (proposal.expiresAt <= now) throw new ApiError(409, 'PROPOSAL_EXPIRED', 'Review a fresh proposal before confirming.');
    if (proposal.startAt <= now) throw new ApiError(409, 'SLOT_UNAVAILABLE', 'Choose a future appointment.');
    const expected = proposal.durationMinutes / 30;
    const claimed = await tx.availabilitySlot.updateMany({
      where: { id: { in: slots.map((slot) => slot.id) }, businessId: session.businessId, staffId: proposal.staffId,
        state: 'AVAILABLE', bookingSlots: { none: { releasedAt: null } } }, data: { state: 'RESERVED' },
    });
    if (slots.length !== expected || claimed.count !== expected) {
      throw new ApiError(409, 'SLOT_UNAVAILABLE', 'The full appointment is unavailable. Refresh availability.');
    }
    const saved = await tx.booking.create({ data: {
      businessId: session.businessId, sessionId: session.id, proposalId: proposal.id,
      reference: 'FP-' + randomUUID().replaceAll('-', '').toUpperCase(),
      customerName: customer.name, customerEmail: customer.email, createdAt: now,
    }, include: { proposal: true } });
    await tx.bookingSlot.createMany({ data: slots.map((slot) => ({
      bookingId: saved.id, businessId: saved.businessId, staffId: proposal.staffId, slotId: slot.id,
    })) });
    const booking = bookingDto(saved);
    await tx.bookingAction.create({ data: {
      businessId: session.businessId, sessionId: session.id, operation: 'CONFIRM', idempotencyKey,
      requestFingerprint: fingerprint, proposalId: proposal.id, bookingId: saved.id, response: booking, createdAt: now,
    } });
    await tx.auditEvent.create({ data: {
      businessId: session.businessId, entityType: 'Booking', entityId: saved.id,
      actorType: 'SYSTEM', actorId: null, eventType: 'BOOKING_CONFIRMED', traceId: request.id,
      metadata: { durationMinutes: proposal.durationMinutes }, createdAt: now,
    } });
    return { booking, replayed: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 10000 });
}
