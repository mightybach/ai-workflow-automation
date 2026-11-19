import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@flowpilot/db';
import { CustomerChatBodySchema, CustomerChatResponseSchema } from '@flowpilot/contracts';
import { customerScope } from './customer-auth.js';
import { MockIntentExtractor } from './mock-intent.js';
import { ApiError } from './errors.js';
import { IntentUnavailable, type IntentExtractor } from './intent.js';
import { businessDate } from '@flowpilot/db';

export function customerChatRoutes(app: FastifyInstance, db: PrismaClient, clock: () => Date, extractor: IntentExtractor = new MockIntentExtractor()) {
  app.post('/api/v1/customer/chat/messages', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = CustomerChatBodySchema.safeParse(request.body);
    if (!body.success || !z.object({}).strict().safeParse(request.query).success) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a message of 1–1000 characters and valid preferences.');
    const referenceTime = clock();
    const load = () => db.$transaction(async (tx) => {
      const now = clock();
      const session = await customerScope(tx, request, now);
      const where = { businessId: session.businessId, active: true };
      const services = await tx.service.findMany({ where, select: { id: true, name: true }, orderBy: { id: 'asc' }, take: 101 });
      const staff = await tx.staff.findMany({ where, select: { id: true, displayName: true }, orderBy: { id: 'asc' }, take: 101 });
      if (services.length > 100 || staff.length > 100) throw new ApiError(409, 'MANUAL_FALLBACK', 'Use the booking form for this larger catalog.');
      return { sessionId: session.id, businessId: session.businessId, input: { ...body.data, services,
        staff: staff.map((person) => ({ id: person.id, name: person.displayName })),
        timezone: session.business.timezone, maximum: session.business.maxBookingDurationMinutes, referenceTime,
      } };
    }, { isolationLevel: 'RepeatableRead' });
    const before = await load();
    const started = performance.now();
    let result;
    try { result = CustomerChatResponseSchema.parse(await extractor.extract(before.input)); }
    catch (error) {
      if (!(error instanceof IntentUnavailable)) throw error;
      request.log.info({ traceId: request.id, provider: 'ollama-v1', reason: error.reason, durationMs: Math.round(performance.now() - started) }, 'Assistant fallback');
      throw new ApiError(503, 'MANUAL_FALLBACK', 'The assistant could not interpret this safely. Use the booking form to choose details and view availability.');
    }
    // Network inference runs outside a database transaction. Reauthenticate and
    // compare the scoped catalog/policy afterward, including expiry and rotation.
    const after = await load();
    if (before.sessionId !== after.sessionId || before.businessId !== after.businessId ||
      JSON.stringify(before.input) !== JSON.stringify(after.input) ||
      businessDate(clock(), result.timezone) !== businessDate(referenceTime, result.timezone)) {
      throw new ApiError(409, 'MANUAL_FALLBACK', 'Booking setup changed. Refresh customer setup and try again.');
    }
    return result;
  });
}
