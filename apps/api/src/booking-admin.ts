import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { businessDayBounds, Prisma, type PrismaClient } from '@flowpilot/db';
import { AdminBookingQuerySchema, AdminBookingListSchema, AdminAuditQuerySchema, AdminAuditListSchema, AdminCancellationResultSchema,
  CancelBookingBodySchema, IdParamsSchema, IdempotencyHeadersSchema } from '@flowpilot/contracts';
import { adminActionId, businessAccess, lockOwnedBusiness, requireOwner } from './business-admin.js';
import { bookingDto } from './booking-service.js';
import { releaseAppointment } from './booking-release.js';
import { ApiError } from './errors.js';
import { enqueueBookingNotification } from './notification-outbox.js';
function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> { const result = schema.safeParse(value); if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Use the booking administration contract.'); return result.data; }
const actionSchema = z.object({ fingerprint: z.string(), response: AdminCancellationResultSchema }).strict();
export async function cancelBusinessBooking(db: PrismaClient, request: FastifyRequest, bookingId: string, key: string, clock: () => Date) {
  const initial = await businessAccess(db, request); requireOwner(initial); const target = bookingId.toLowerCase();
  const fingerprint = createHash('sha256').update(JSON.stringify(['owner-cancel:v1', target])).digest('hex');
  const id = adminActionId('owner-cancel:v1', initial.membership.businessId, initial.actor.id, key);
  return db.$transaction(async (tx) => {
    const access = await lockOwnedBusiness(tx, request, initial); const businessId = access.membership.businessId;
    const prior = await tx.auditEvent.findUnique({ where: { id } });
    if (prior) {
      const value = actionSchema.parse(prior.metadata);
      if (prior.businessId !== businessId || prior.actorId !== access.actor.id || value.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different cancellation.');
      return { result: value.response, replayed: true };
    }
    const owned = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Booking" WHERE id = ${target}::uuid AND "businessId" = ${businessId}::uuid FOR UPDATE`);
    if (!owned.length) throw new ApiError(404, 'NOT_FOUND', 'Booking not found.');
    let saved = await tx.booking.findUniqueOrThrow({ where: { id: target }, include: { proposal: true } }); let now = clock(); const changed = saved.status === 'CONFIRMED';
    if (changed) {
      const released = await releaseAppointment(tx, saved, clock, async () => { const current = await businessAccess(tx, request); requireOwner(current); }); saved = released.saved; now = released.now;
      await tx.business.update({ where: { id: businessId }, data: { updatedAt: new Date(Math.max(+now, +access.membership.business.updatedAt + 1)) } });
    }
    const result = AdminCancellationResultSchema.parse({ id: saved.id, reference: saved.reference, status: saved.status, cancelledAt: saved.cancelledAt!.toISOString() });
    await tx.auditEvent.create({ data: { id, businessId, entityType: 'Booking', entityId: target, actorType: 'USER', actorId: access.actor.id,
      eventType: changed ? 'BOOKING_CANCELLED_BY_OWNER' : 'BOOKING_CANCELLATION_CHECKED', traceId: request.id, metadata: { fingerprint, response: result }, createdAt: now } });
    if (changed) await enqueueBookingNotification(tx, { eventType: 'BOOKING_CANCELLED', businessId: saved.businessId, bookingId: saved.id, previousBookingId: null, occurredAt: now.toISOString(), traceId: request.id });
    return { result, replayed: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 10000 });
}
export function bookingAdminRoutes(app: FastifyInstance, db: PrismaClient, clock: () => Date) {
  app.get('/api/v1/admin/bookings/:id', async (request) => {
    input(z.object({}).strict(), request.query); const { id } = input(IdParamsSchema, request.params);
    return db.$transaction(async (tx) => { const { membership } = await businessAccess(tx, request);
      const row = await tx.booking.findFirst({ where: { id, businessId: membership.businessId }, include: { proposal: true } });
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Booking not found.'); return bookingDto(row);
    }, { isolationLevel: 'RepeatableRead' });
  });
  app.get('/api/v1/admin/bookings', async (request) => {
    const query = input(AdminBookingQuerySchema, request.query);
    return db.$transaction(async (tx) => {
      const { membership } = await businessAccess(tx, request); const businessId = membership.businessId;
      if (query.staffId && !await tx.staff.findFirst({ where: { id: query.staffId, businessId } })) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
      const bounds = query.date ? businessDayBounds(query.date, membership.business.timezone) : null;
      const where: Prisma.BookingWhereInput = { businessId, ...(query.status ? { status: query.status } : {}), proposal: { ...(query.staffId ? { staffId: query.staffId } : {}), ...(bounds ? { startAt: { gte: bounds.start, lt: bounds.end } } : {}) } };
      const rows = await tx.booking.findMany({ where, include: { proposal: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize });
      return AdminBookingListSchema.parse({ items: rows.map(bookingDto), pagination: { page: query.page, pageSize: query.pageSize, total: await tx.booking.count({ where }) } });
    }, { isolationLevel: 'RepeatableRead' });
  });
  app.get('/api/v1/admin/audit-events', async (request) => {
    const query = input(AdminAuditQuerySchema, request.query);
    return db.$transaction(async (tx) => {
      const { membership } = await businessAccess(tx, request); const businessId = membership.businessId;
      if (query.bookingId && !await tx.booking.findFirst({ where: { id: query.bookingId, businessId } })) throw new ApiError(404, 'NOT_FOUND', 'Booking not found.');
      const bounds = query.date ? businessDayBounds(query.date, membership.business.timezone) : null;
      const where: Prisma.AuditEventWhereInput = { businessId, ...(bounds ? { createdAt: { gte: bounds.start, lt: bounds.end } } : {}), ...(query.bookingId ? { entityType: 'Booking', entityId: query.bookingId } : {}) };
      const rows = await tx.auditEvent.findMany({ where, select: { id: true, entityType: true, entityId: true, actorType: true, eventType: true, createdAt: true, traceId: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize });
      return AdminAuditListSchema.parse({ items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })), pagination: { page: query.page, pageSize: query.pageSize, total: await tx.auditEvent.count({ where }) } });
    }, { isolationLevel: 'RepeatableRead' });
  });
  app.post('/api/v1/admin/bookings/:id/cancel', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    input(z.object({}).strict(), request.query); input(CancelBookingBodySchema, request.body); const { id } = input(IdParamsSchema, request.params);
    const key = input(IdempotencyHeadersSchema, { 'idempotency-key': request.headers['idempotency-key'] })['idempotency-key'];
    const result = await cancelBusinessBooking(db, request, id, key, clock); reply.header('Idempotency-Replayed', String(result.replayed)); return result.result;
  });
}
