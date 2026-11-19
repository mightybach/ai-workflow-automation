import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@flowpilot/db';
import { z } from 'zod';
import {
  BusinessBookingSettingsSchema, BookingDurationMinutesSchema, IdempotencyHeadersSchema,
  UpdateBusinessBookingSettingsSchema, type UpdateBusinessBookingSettings,
} from '@flowpilot/contracts';
import { adminActionId, businessAccess as scope, lockOwnedBusiness, requireOwner } from './business-admin.js';
import { ApiError } from './errors.js';

const eventType = 'BUSINESS_BOOKING_DURATION_UPDATED';
const replaySchema = z.object({
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  previousMaximumMinutes: BookingDurationMinutesSchema,
  response: BusinessBookingSettingsSchema,
}).strict();
function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Use a maximum of 30-1440 minutes in 30-minute increments and the latest settings revision.');
  return parsed.data;
}
const dto = (business: { id: string; maxBookingDurationMinutes: number; updatedAt: Date }) => BusinessBookingSettingsSchema.parse({
  businessId: business.id, maxBookingDurationMinutes: business.maxBookingDurationMinutes, updatedAt: business.updatedAt.toISOString(),
});

export async function updateBookingSettings(db: PrismaClient, request: FastifyRequest, body: UpdateBusinessBookingSettings, key: string, clock: () => Date) {
  const initial = await scope(db, request);
  requireOwner(initial);
  const fingerprint = createHash('sha256').update(JSON.stringify(['booking-settings:v1', body.maxBookingDurationMinutes, new Date(body.expectedUpdatedAt).toISOString()])).digest('hex');
  const id = adminActionId('booking-settings:v1', initial.membership.businessId, initial.actor.id, key);
  return db.$transaction(async (tx) => {
    // Same first lock as proposal/confirmation, exclusive instead of FOR SHARE.
    // It serializes policy edits with booking decisions across API processes.
    const current = await lockOwnedBusiness(tx, request, initial);
    const prior = await tx.auditEvent.findUnique({ where: { id } });
    if (prior) {
      if (prior.businessId !== current.membership.businessId || prior.actorId !== current.actor.id || prior.eventType !== eventType) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This settings key is unavailable.');
      const saved = replaySchema.parse(prior.metadata);
      if (saved.requestFingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used for different settings.');
      return { settings: saved.response, replayed: true };
    }
    const business = current.membership.business;
    if (+business.updatedAt !== Date.parse(body.expectedUpdatedAt)) throw new ApiError(409, 'SETTINGS_CHANGED', 'Settings changed since you loaded them. Refresh settings and review the latest value.');
    const updated = business.maxBookingDurationMinutes === body.maxBookingDurationMinutes ? business : await tx.business.update({
      where: { id: business.id }, data: {
        maxBookingDurationMinutes: body.maxBookingDurationMinutes,
        // Millisecond monotonic revision also handles rapid edits/clock rounding.
        updatedAt: new Date(Math.max(+clock(), +business.updatedAt + 1)),
      },
    });
    const settings = dto(updated);
    await tx.auditEvent.create({ data: {
      id, businessId: business.id, entityType: 'Business', entityId: business.id,
      actorType: 'USER', actorId: current.actor.id, eventType, traceId: request.id,
      metadata: { requestFingerprint: fingerprint, previousMaximumMinutes: business.maxBookingDurationMinutes, response: settings }, createdAt: clock(),
    } });
    return { settings, replayed: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 10000 });
}

export function businessSettingsRoutes(app: FastifyInstance, db: PrismaClient, clock: () => Date) {
  app.get('/api/v1/admin/business/booking-settings', async (request) => {
    input(z.object({}).strict(), request.query);
    return db.$transaction(async (tx) => dto((await scope(tx, request)).membership.business), { isolationLevel: 'RepeatableRead' });
  });
  app.put('/api/v1/admin/business/booking-settings', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    input(z.object({}).strict(), request.query);
    const body = input(UpdateBusinessBookingSettingsSchema, request.body);
    const headers = input(IdempotencyHeadersSchema, { 'idempotency-key': request.headers['idempotency-key'] });
    const result = await updateBookingSettings(db, request, body, headers['idempotency-key'], clock);
    reply.header('Idempotency-Replayed', String(result.replayed));
    return result.settings;
  });
}
