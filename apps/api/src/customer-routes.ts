import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDayBounds, Prisma, type PrismaClient } from '@flowpilot/db';
import {
  CreateCustomerSessionBodySchema, CustomerCatalogQuerySchema, CustomerAvailabilityQuerySchema,
  CustomerAvailabilityResponseSchema, CUSTOMER_SESSION_TTL_SECONDS,
  LogoutResponseSchema, ServiceListResponseSchema, StaffListResponseSchema,
  CreateBookingProposalBodySchema, IdempotencyHeadersSchema,
  ConfirmBookingBodySchema, IdParamsSchema,
} from '@flowpilot/contracts';
import { ApiError } from './errors.js';
import { createBookingProposal } from './booking-proposal-service.js';
import { confirmBooking, bookingDto } from './booking-service.js';
import {
  customerCookieName, customerCookieOptions, customerScope, customerSessionDto,
  customerTokenHash, newCustomerToken, requestCustomerToken,
} from './customer-auth.js';

const emptyInput = z.object({}).strict();
function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Input does not match the customer API contract.');
  return parsed.data;
}
export function customerRoutes(app: FastifyInstance, db: PrismaClient, clock: () => Date) {
  const readLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  app.post('/api/v1/customer/bookings', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    input(emptyInput, request.query);
    const body = input(ConfirmBookingBodySchema, request.body);
    const headers = input(IdempotencyHeadersSchema, { 'idempotency-key': request.headers['idempotency-key'] });
    const result = await confirmBooking(db, request, body, headers['idempotency-key'], clock);
    return reply.code(result.replayed ? 200 : 201).send(result.booking);
  });
  app.get('/api/v1/customer/bookings/:id', readLimit, async (request) => {
    input(emptyInput, request.query);
    const { id } = input(IdParamsSchema, request.params);
    const now = clock();
    return db.$transaction(async (tx) => {
      const session = await customerScope(tx, request, now);
      const saved = await tx.booking.findFirst({ where: { id, businessId: session.businessId, sessionId: session.id }, include: { proposal: true } });
      if (!saved) throw new ApiError(404, 'NOT_FOUND', 'Booking not found.');
      return bookingDto(saved);
    }, { isolationLevel: 'RepeatableRead' });
  });
  app.post('/api/v1/customer/booking-proposals', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    input(emptyInput, request.query);
    const body = input(CreateBookingProposalBodySchema, request.body);
    const headers = input(IdempotencyHeadersSchema, { 'idempotency-key': request.headers['idempotency-key'] });
    const result = await createBookingProposal(db, request, body, headers['idempotency-key'], clock);
    return reply.code(result.replayed ? 200 : 201).send(result.proposal);
  });
  app.post('/api/v1/customer/sessions', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    input(emptyInput, request.query);
    const body = input(CreateCustomerSessionBodySchema, request.body);
    const now = clock();
    const fresh = newCustomerToken(now);
    const oldToken = requestCustomerToken(request);
    const result = await db.$transaction(async (tx) => {
      const business = await tx.business.findUnique({ where: { slug: body.businessSlug } });
      if (!business?.active) throw new ApiError(404, 'NOT_FOUND', 'Business not found.');
      const old = oldToken ? await tx.customerSession.findUnique({ where: { tokenHash: customerTokenHash(oldToken) } }) : null;
      // Preserve ownership when a live same-business session rotates its secret.
      if (old && !old.revokedAt && old.expiresAt > now && old.businessId === business.id) {
        const updated = await tx.customerSession.updateMany({
          where: { id: old.id, tokenHash: old.tokenHash, revokedAt: null, expiresAt: { gt: now } },
          data: { tokenHash: fresh.tokenHash, expiresAt: fresh.expiresAt },
        });
        if (updated.count !== 1) throw new ApiError(401, 'UNAUTHENTICATED', 'Customer session changed. Retry with your current cookie.');
        return { ...old, business, tokenHash: fresh.tokenHash, expiresAt: fresh.expiresAt };
      }
      if (old && !old.revokedAt) {
        await tx.customerSession.updateMany({ where: { id: old.id, tokenHash: old.tokenHash, revokedAt: null }, data: { revokedAt: now } });
      }
      const session = await tx.customerSession.create({
        data: { businessId: business.id, tokenHash: fresh.tokenHash, createdAt: now, expiresAt: fresh.expiresAt }, include: { business: true },
      });
      return session;
    });
    reply.setCookie(customerCookieName, fresh.token, { ...customerCookieOptions, maxAge: CUSTOMER_SESSION_TTL_SECONDS });
    return reply.code(201).send(customerSessionDto(result, now));
  });
  app.get('/api/v1/customer/session', readLimit, async (request) => {
    input(emptyInput, request.query);
    const now = clock();
    return db.$transaction(async (tx) => customerSessionDto(await customerScope(tx, request, now), now));
  });
  app.post('/api/v1/customer/logout', readLimit, async (request, reply) => {
    input(emptyInput, request.query);
    input(emptyInput, request.body === undefined ? {} : request.body);
    const token = requestCustomerToken(request);
    if (token) await db.customerSession.updateMany({
      where: { tokenHash: customerTokenHash(token), revokedAt: null }, data: { revokedAt: clock() },
    });
    reply.clearCookie(customerCookieName, customerCookieOptions);
    return LogoutResponseSchema.parse({ ok: true });
  });
  app.get('/api/v1/customer/services', readLimit, async (request) => {
    const query = input(CustomerCatalogQuerySchema, request.query);
    const now = clock();
    return db.$transaction(async (tx) => {
      const session = await customerScope(tx, request, now);
      const where = { businessId: session.businessId, active: true };
      const items = await tx.service.findMany({ where, select: { id: true, businessId: true, name: true, durationMinutes: true, active: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize });
      return ServiceListResponseSchema.parse({ items, pagination: { ...query, total: await tx.service.count({ where }) } });
    }, { isolationLevel: 'RepeatableRead' });
  });
  app.get('/api/v1/customer/staff', readLimit, async (request) => {
    const query = input(CustomerCatalogQuerySchema, request.query);
    const now = clock();
    return db.$transaction(async (tx) => {
      const session = await customerScope(tx, request, now);
      const where = { businessId: session.businessId, active: true };
      const items = await tx.staff.findMany({ where, select: { id: true, businessId: true, displayName: true, active: true },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize });
      return StaffListResponseSchema.parse({ items, pagination: { ...query, total: await tx.staff.count({ where }) } });
    }, { isolationLevel: 'RepeatableRead' });
  });
  app.get('/api/v1/customer/availability', readLimit, async (request) => {
    const query = input(CustomerAvailabilityQuerySchema, request.query);
    const now = clock();
    return db.$transaction(async (tx) => {
      const session = await customerScope(tx, request, now);
      const service = await tx.service.findFirst({ where: { id: query.serviceId, businessId: session.businessId, active: true } });
      if (!service) throw new ApiError(404, 'NOT_FOUND', 'Service not found.');
      if (query.staffId && !await tx.staff.findFirst({ where: { id: query.staffId, businessId: session.businessId, active: true } })) {
        throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
      }
      if (query.durationMinutes > session.business.maxBookingDurationMinutes) {
        throw new ApiError(409, 'DURATION_NOT_ALLOWED', 'Choose a duration within the current business maximum.');
      }
      const bounds = businessDayBounds(query.date, session.business.timezone);
      const staffFilter = query.staffId ? Prisma.sql`AND first."staffId" = ${query.staffId}::uuid` : Prisma.empty;
      // All interpolated values are bound SQL parameters. A start qualifies only
      // if every expected aligned base slot is available for this same employee.
      const eligible = Prisma.sql`WITH eligible AS (
        SELECT first.id, first."staffId", first."startAt", employee."displayName",
          first."startAt" + ${query.durationMinutes} * INTERVAL '1 minute' AS "endAt"
        FROM "AvailabilitySlot" first JOIN "Staff" employee
          ON employee.id = first."staffId" AND employee."businessId" = first."businessId" AND employee.active
        WHERE first."businessId" = ${session.businessId}::uuid
          AND first."startAt" >= ${bounds.start} AND first."startAt" < ${bounds.end}
          AND first."startAt" > ${now} AND first.state = 'AVAILABLE' ${staffFilter}
          AND (SELECT count(*) FROM "AvailabilitySlot" part
            WHERE part."businessId" = first."businessId" AND part."staffId" = first."staffId"
              AND part."startAt" >= first."startAt"
              AND part."startAt" < first."startAt" + ${query.durationMinutes} * INTERVAL '1 minute'
              AND part.state = 'AVAILABLE'
              AND NOT EXISTS (SELECT 1 FROM "BookingSlot" claim WHERE claim."slotId" = part.id AND claim."releasedAt" IS NULL)
          ) = ${query.durationMinutes / 30}
      )`;
      const counts = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`${eligible} SELECT count(*) AS total FROM eligible`);
      const rows = await tx.$queryRaw<{ id: string; staffId: string; startAt: Date; endAt: Date; displayName: string }[]>(Prisma.sql`
        ${eligible} SELECT * FROM eligible ORDER BY "startAt", "staffId", id
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
      return CustomerAvailabilityResponseSchema.parse({
        items: rows.map((row) => ({ businessId: session.businessId, slotId: row.id, staffId: row.staffId,
          serviceId: service.id, serviceName: service.name, staffName: row.displayName,
          durationMinutes: query.durationMinutes, startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString(), timezone: session.business.timezone })),
        pagination: { page: query.page, pageSize: query.pageSize, total: Number(counts[0]!.total) },
        date: query.date, timezone: session.business.timezone, asOf: now.toISOString(),
      });
    }, { isolationLevel: 'RepeatableRead' });
  });
}
