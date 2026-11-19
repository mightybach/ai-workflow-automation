import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { businessDayBounds, Prisma, type PrismaClient } from '@flowpilot/db';
import {
  IdempotencyHeadersSchema, ScheduleQuerySchema, ScheduleResponseSchema, ScheduleChangeResponseSchema,
  UpdateScheduleSchema, type UpdateSchedule,
} from '@flowpilot/contracts';
import { ApiError } from './errors.js';
import { adminActionId, businessAccess, lockOwnedBusiness, requireOwner } from './business-admin.js';

const eventType = 'BUSINESS_SCHEDULE_UPDATED';
const replaySchema = z.object({ requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  changedSlotIds: z.array(z.string().uuid()).max(500), response: ScheduleChangeResponseSchema }).strict();
function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Select existing slots, AVAILABLE or BLOCKED, and the latest schedule revision.');
  return result.data;
}
export async function updateSchedule(db: PrismaClient, request: FastifyRequest, body: UpdateSchedule, key: string, clock: () => Date) {
  const initial = await businessAccess(db, request); requireOwner(initial);
  const slotIds = body.slotIds.map((id) => id.toLowerCase()).sort();
  const fingerprint = createHash('sha256').update(JSON.stringify(['schedule:v1', slotIds, body.state, new Date(body.expectedUpdatedAt).toISOString()])).digest('hex');
  const id = adminActionId('schedule:v1', initial.membership.businessId, initial.actor.id, key);
  return db.$transaction(async (tx) => {
    const { membership, actor } = await lockOwnedBusiness(tx, request, initial);
    const prior = await tx.auditEvent.findUnique({ where: { id } });
    if (prior) {
      if (prior.businessId !== membership.businessId || prior.actorId !== actor.id || prior.eventType !== eventType) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This schedule key is unavailable.');
      const saved = replaySchema.parse(prior.metadata);
      if (saved.requestFingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used for a different schedule change.');
      return { change: saved.response, replayed: true };
    }
    if (+membership.business.updatedAt !== Date.parse(body.expectedUpdatedAt)) throw new ApiError(409, 'SCHEDULE_CHANGED', 'Business settings or schedule changed. Refresh the schedule and review again.');
    const where = { businessId: membership.businessId, id: { in: slotIds } };
    const selected = await tx.availabilitySlot.findMany({ where, select: { staffId: true } });
    if (selected.length !== slotIds.length) throw new ApiError(404, 'NOT_FOUND', 'One or more selected slots are unavailable in this business.');
    const staffIds = [...new Set(selected.map((slot) => slot.staffId))].sort();
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Staff" WHERE "businessId" = ${membership.businessId}::uuid AND id IN (${Prisma.join(staffIds.map((staffId) => Prisma.sql`${staffId}::uuid`))}) ORDER BY id FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "AvailabilitySlot" WHERE "businessId" = ${membership.businessId}::uuid AND id IN (${Prisma.join(slotIds.map((slotId) => Prisma.sql`${slotId}::uuid`))}) ORDER BY "startAt", "staffId", id FOR UPDATE`);
    const slots = await tx.availabilitySlot.findMany({ where, include: { staff: { select: { active: true } }, bookingSlots: { where: { releasedAt: null }, select: { bookingId: true }, take: 1 } } });
    const now = clock();
    if (slots.some((slot) => slot.startAt <= now)) throw new ApiError(409, 'PAST_SLOT', 'Only future inventory can be changed. Refresh the schedule.');
    if (slots.some((slot) => slot.state === 'RESERVED' || slot.bookingSlots.length)) throw new ApiError(409, 'SLOT_RESERVED', 'A selected time is reserved. No slots were changed; refresh and select unreserved times.');
    if (body.state === 'AVAILABLE' && slots.some((slot) => !slot.staff.active)) throw new ApiError(409, 'STAFF_UNAVAILABLE', 'An inactive staff member cannot be reopened for booking.');
    if (body.state === 'AVAILABLE') {
      const closed = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT c.id FROM "ScheduleClosure" c JOIN "AvailabilitySlot" s ON s."businessId" = c."businessId"
        AND (c."staffId" IS NULL OR c."staffId" = s."staffId") AND c."startAt" < s."endAt" AND c."endAt" > s."startAt"
        WHERE s."businessId" = ${membership.businessId}::uuid AND s.id IN (${Prisma.join(slotIds.map((slotId) => Prisma.sql`${slotId}::uuid`))}) AND c."releasedAt" IS NULL LIMIT 1`);
      if (closed.length) throw new ApiError(409, 'CLOSURE_ACTIVE', 'Lift every covering closure before reopening these slots.');
    }
    const changedSlotIds = slots.filter((slot) => slot.state !== body.state).map((slot) => slot.id).sort();
    if (changedSlotIds.length) {
      const changed = await tx.availabilitySlot.updateMany({ where: { businessId: membership.businessId, id: { in: changedSlotIds },
        state: body.state === 'AVAILABLE' ? 'BLOCKED' : 'AVAILABLE', startAt: { gt: now }, bookingSlots: { none: { releasedAt: null } },
        ...(body.state === 'AVAILABLE' ? { staff: { active: true } } : {}),
      }, data: { state: body.state } });
      if (changed.count !== changedSlotIds.length) throw new ApiError(409, 'SCHEDULE_CHANGED', 'Selected inventory changed. No slots were changed; refresh and try again.');
    }
    const business = changedSlotIds.length ? await tx.business.update({ where: { id: membership.businessId },
      data: { updatedAt: new Date(Math.max(+now, +membership.business.updatedAt + 1)) } }) : membership.business;
    const change = ScheduleChangeResponseSchema.parse({ businessId: business.id, updatedAt: business.updatedAt.toISOString(), state: body.state,
      selectedCount: slots.length, changedCount: changedSlotIds.length });
    await tx.auditEvent.create({ data: { id, businessId: business.id, entityType: 'Schedule', entityId: business.id,
      actorType: 'USER', actorId: actor.id, eventType, traceId: request.id,
      metadata: { requestFingerprint: fingerprint, changedSlotIds, response: change }, createdAt: now } });
    return { change, replayed: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 10000 });
}
export function scheduleRoutes(app: FastifyInstance, db: PrismaClient, clock: () => Date) {
  app.get('/api/v1/admin/schedule', async (request) => {
    const query = input(ScheduleQuerySchema, request.query);
    return db.$transaction(async (tx) => {
      const { membership } = await businessAccess(tx, request);
      if (query.staffId && !await tx.staff.findFirst({ where: { id: query.staffId, businessId: membership.businessId } })) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
      const bounds = businessDayBounds(query.date, membership.business.timezone);
      const slots = await tx.availabilitySlot.findMany({ where: { businessId: membership.businessId,
        startAt: { gte: bounds.start, lt: bounds.end }, ...(query.staffId ? { staffId: query.staffId } : {}) },
        include: { staff: { select: { displayName: true, active: true } } }, orderBy: [{ startAt: 'asc' }, { staffId: 'asc' }, { id: 'asc' }], take: 501 });
      if (slots.length > 500) throw new ApiError(409, 'SCHEDULE_TOO_LARGE', 'Select a staff member to reduce this schedule view.');
      return ScheduleResponseSchema.parse({ businessId: membership.businessId, date: query.date, timezone: membership.business.timezone,
        updatedAt: membership.business.updatedAt.toISOString(), referenceTime: clock().toISOString(), items: slots.map((slot) => ({
          id: slot.id, businessId: slot.businessId, staffId: slot.staffId, staffName: slot.staff.displayName, staffActive: slot.staff.active,
          startAt: slot.startAt.toISOString(), endAt: slot.endAt.toISOString(), state: slot.state,
        })) });
    }, { isolationLevel: 'RepeatableRead' });
  });
  app.put('/api/v1/admin/schedule', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    input(z.object({}).strict(), request.query);
    const body = input(UpdateScheduleSchema, request.body);
    const headers = input(IdempotencyHeadersSchema, { 'idempotency-key': request.headers['idempotency-key'] });
    const result = await updateSchedule(db, request, body, headers['idempotency-key'], clock);
    reply.header('Idempotency-Replayed', String(result.replayed));
    return result.change;
  });
}
