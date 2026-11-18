import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@flowpilot/db';
import { CustomerChatBodySchema, CustomerChatResponseSchema } from '@flowpilot/contracts';
import { customerScope } from './customer-auth.js';
import { MockIntentExtractor } from './mock-intent.js';
import { ApiError } from './errors.js';

export function customerChatRoutes(app: FastifyInstance, db: PrismaClient, clock: () => Date) {
  const extractor = new MockIntentExtractor();
  app.post('/api/v1/customer/chat/messages', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = CustomerChatBodySchema.safeParse(request.body);
    if (!body.success || !z.object({}).strict().safeParse(request.query).success) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a message of 1–1000 characters and valid preferences.');
    const referenceTime = clock();
    return db.$transaction(async (tx) => {
      const session = await customerScope(tx, request, referenceTime);
      const where = { businessId: session.businessId, active: true };
      const services = await tx.service.findMany({ where, select: { id: true, name: true }, orderBy: { id: 'asc' }, take: 101 });
      const staff = await tx.staff.findMany({ where, select: { id: true, displayName: true }, orderBy: { id: 'asc' }, take: 101 });
      if (services.length > 100 || staff.length > 100) throw new ApiError(409, 'MANUAL_FALLBACK', 'Use the booking form for this larger catalog.');
      return CustomerChatResponseSchema.parse(extractor.extract({ ...body.data, services,
        staff: staff.map((person) => ({ id: person.id, name: person.displayName })),
        timezone: session.business.timezone, maximum: session.business.maxBookingDurationMinutes, referenceTime,
      }));
    }, { isolationLevel: 'RepeatableRead' });
  });
}
