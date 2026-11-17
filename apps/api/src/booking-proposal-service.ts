import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@flowpilot/db';
import {
  BOOKING_PROPOSAL_TTL_SECONDS, BookingProposalResponseSchema, type CreateBookingProposalBody,
} from '@flowpilot/contracts';
import { customerScope } from './customer-auth.js';
import { ApiError } from './errors.js';

export async function createBookingProposal(
  db: PrismaClient, request: FastifyRequest, body: CreateBookingProposalBody,
  idempotencyKey: string, clock: () => Date,
) {
  const input = { slotId: body.slotId.toLowerCase(), serviceId: body.serviceId.toLowerCase(), durationMinutes: body.durationMinutes };
  const fingerprint = createHash('sha256').update(JSON.stringify(['proposal:v1', input.slotId, input.serviceId, input.durationMinutes])).digest('hex');
  return db.$transaction(async (tx) => {
    const initial = await customerScope(tx, request, clock());
    // Serialize one scoped operation key across API instances. This is not an
    // inventory hold. Database uniqueness remains the persisted final guard.
    const lock = createHash('sha256').update(JSON.stringify([initial.businessId, initial.id, 'PROPOSE', idempotencyKey])).digest().readBigInt64BE();
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${lock}::bigint)::text`);
    // Coordinate policy changes/revocation with this short write transaction;
    // no availability row is locked or reserved by a proposal.
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${initial.businessId}::uuid FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "CustomerSession" WHERE id = ${initial.id}::uuid AND "businessId" = ${initial.businessId}::uuid FOR SHARE`);
    // A request may have waited for a competing retry; recheck its live identity.
    const now = clock();
    const session = await customerScope(tx, request, now);
    const existing = await tx.bookingAction.findUnique({ where: {
      businessId_sessionId_operation_idempotencyKey: {
        businessId: session.businessId, sessionId: session.id, operation: 'PROPOSE', idempotencyKey,
      },
    } });
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used for a different selection.');
      }
      return { proposal: BookingProposalResponseSchema.parse(existing.response), replayed: true };
    }
    const service = await tx.service.findFirst({ where: { id: input.serviceId, businessId: session.businessId, active: true } });
    if (!service) throw new ApiError(404, 'NOT_FOUND', 'Service not found.');
    const first = await tx.availabilitySlot.findFirst({
      where: { id: input.slotId, businessId: session.businessId, staff: { active: true } }, include: { staff: true },
    });
    if (!first) throw new ApiError(404, 'NOT_FOUND', 'Slot not found.');
    if (input.durationMinutes > session.business.maxBookingDurationMinutes) {
      throw new ApiError(409, 'DURATION_NOT_ALLOWED', 'Choose a duration within the current business maximum.');
    }
    const endAt = new Date(+first.startAt + input.durationMinutes * 60000);
    if (first.startAt <= now || first.state !== 'AVAILABLE') {
      throw new ApiError(409, 'SLOT_UNAVAILABLE', 'Choose a future available appointment.');
    }
    const count = await tx.availabilitySlot.count({ where: {
      businessId: session.businessId, staffId: first.staffId,
      startAt: { gte: first.startAt, lt: endAt }, state: 'AVAILABLE',
      bookingSlots: { none: { releasedAt: null } },
    } });
    if (count !== input.durationMinutes / 30) {
      throw new ApiError(409, 'SLOT_UNAVAILABLE', 'The full appointment is unavailable. Refresh availability.');
    }
    const saved = await tx.bookingProposal.create({ data: {
      businessId: session.businessId, sessionId: session.id,
      serviceId: service.id, staffId: first.staffId, slotId: first.id,
      durationMinutes: input.durationMinutes, startAt: first.startAt, endAt,
      timezone: session.business.timezone, serviceName: service.name, staffName: first.staff.displayName,
      createdAt: now, expiresAt: new Date(+now + BOOKING_PROPOSAL_TTL_SECONDS * 1000),
    } });
    const proposal = BookingProposalResponseSchema.parse({
      id: saved.id, businessId: saved.businessId, slotId: saved.slotId, serviceId: saved.serviceId,
      staffId: saved.staffId, serviceName: saved.serviceName, staffName: saved.staffName,
      durationMinutes: saved.durationMinutes, timezone: saved.timezone,
      startAt: saved.startAt.toISOString(), endAt: saved.endAt.toISOString(),
      createdAt: saved.createdAt.toISOString(), expiresAt: saved.expiresAt.toISOString(),
    });
    await tx.bookingAction.create({ data: {
      businessId: session.businessId, sessionId: session.id, operation: 'PROPOSE',
      idempotencyKey, requestFingerprint: fingerprint, proposalId: saved.id, response: proposal, createdAt: now,
    } });
    await tx.auditEvent.create({ data: {
      businessId: session.businessId, entityType: 'BookingProposal', entityId: saved.id,
      actorType: 'SYSTEM', actorId: null, eventType: 'BOOKING_PROPOSED', traceId: request.id,
      metadata: { durationMinutes: saved.durationMinutes }, createdAt: now,
    } });
    return { proposal, replayed: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 10000 });
}
