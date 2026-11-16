import type { FastifyInstance } from 'fastify';
import { businessDate, businessDayBounds, type PrismaClient } from '@flowpilot/db';
import {
  AdminListQuerySchema, AdminSlotQuerySchema, AdminSlotListResponseSchema,
  BusinessSetupResponseSchema, ServiceListResponseSchema, StaffListResponseSchema,
} from '@flowpilot/contracts';
import { z } from 'zod';
import { authentication } from './auth.js';
import { ApiError } from './errors.js';

function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Input does not match the business API contract.');
  return result.data;
}
export function businessRoutes(app: FastifyInstance, db: PrismaClient, clock: () => Date) {
  const authenticate = authentication(db);
  async function scope(request: Parameters<ReturnType<typeof authentication>>[0]) {
    const actor = await authenticate(request);
    const membership = await db.businessMembership.findUnique({ where: { userId: actor.id }, include: { business: true } });
    if (!membership || !membership.active || !membership.business.active) {
      throw new ApiError(403, 'BUSINESS_ACCESS_REQUIRED', 'This account has no active business access.');
    }
    return membership;
  }
  app.get('/api/v1/admin/business', async (request) => {
    const membership = await scope(request);
    input(z.object({}).strict(), request.query);
    const { business } = membership;
    return BusinessSetupResponseSchema.parse({
      business: { id: business.id, name: business.name, timezone: business.timezone, active: business.active },
      membership: { role: membership.role }, today: businessDate(clock(), business.timezone),
    });
  });
  app.get('/api/v1/admin/staff', async (request) => {
    const membership = await scope(request);
    const query = input(AdminListQuerySchema, request.query);
    const where = { businessId: membership.businessId };
    const [items, total] = await db.$transaction([
      db.staff.findMany({ where, select: { id: true, businessId: true, displayName: true, active: true },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      db.staff.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return StaffListResponseSchema.parse({ items, pagination: { ...query, total } });
  });
  app.get('/api/v1/admin/services', async (request) => {
    const membership = await scope(request);
    const query = input(AdminListQuerySchema, request.query);
    const where = { businessId: membership.businessId };
    const [items, total] = await db.$transaction([
      db.service.findMany({ where, select: { id: true, businessId: true, name: true, durationMinutes: true, active: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      db.service.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return ServiceListResponseSchema.parse({ items, pagination: { ...query, total } });
  });
  app.get('/api/v1/admin/slots', async (request) => {
    const membership = await scope(request);
    const query = input(AdminSlotQuerySchema, request.query);
    if (query.staffId && !await db.staff.findFirst({ where: { id: query.staffId, businessId: membership.businessId } })) {
      throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
    }
    const bounds = businessDayBounds(query.date, membership.business.timezone);
    const where = {
      businessId: membership.businessId, startAt: { gte: bounds.start, lt: bounds.end },
      ...(query.staffId ? { staffId: query.staffId } : {}),
      ...(query.state ? { state: query.state } : {}),
    };
    const [records, total] = await db.$transaction([
      db.availabilitySlot.findMany({ where, orderBy: [{ startAt: 'asc' }, { staffId: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      db.availabilitySlot.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return AdminSlotListResponseSchema.parse({
      items: records.map((slot) => ({
        id: slot.id, businessId: slot.businessId, staffId: slot.staffId,
        startAt: slot.startAt.toISOString(), endAt: slot.endAt.toISOString(), state: slot.state,
      })),
      pagination: { page: query.page, pageSize: query.pageSize, total },
      date: query.date, timezone: membership.business.timezone,
    });
  });
}

