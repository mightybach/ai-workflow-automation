import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { ActorTypeSchema, OrderStatusSchema } from './enums.js';

// Future read DTOs. No audit/order HTTP endpoints are implemented yet.
// metadata must be redacted by the server before applying this schema.
export const AuditEventResponseSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  actorType: ActorTypeSchema,
  actorId: IdSchema.nullable(),
  eventType: z.string().min(1).max(100),
  traceId: z.string().min(1).max(128),
  metadata: z.record(z.string(), z.json()).nullable(),
  createdAt: TimestampSchema,
}).strict().superRefine((event, context) => {
  if ((event.actorType === 'USER') !== (event.actorId !== null)) {
    context.addIssue({ code: 'custom', path: ['actorId'], message: 'Only USER events must reference a user.' });
  }
});

// Decimal(12,2): at most 10 whole digits and exactly two fractional digits.
// Decimal values cross the JSON boundary as strings, never JS floating-point numbers.
export const MoneyAmountSchema = z.string().regex(/^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/);
export const MockOrderResponseSchema = z.object({
  id: IdSchema,
  orderNumber: z.string().min(1),
  status: OrderStatusSchema,
  deliveredAt: TimestampSchema.nullable(),
  totalAmount: MoneyAmountSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  createdAt: TimestampSchema,
}).strict();

export type AuditEventResponse = z.infer<typeof AuditEventResponseSchema>;
export type MockOrderResponse = z.infer<typeof MockOrderResponseSchema>;

