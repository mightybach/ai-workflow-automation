import { z } from 'zod';

export const IdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime();
export const IdParamsSchema = z.object({ id: IdSchema }).strict();
export const IdempotencyKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const IdempotencyHeadersSchema = z.object({ 'idempotency-key': IdempotencyKeySchema }).strict();

// HTTP query values may be strings; reject booleans, null, blanks and arrays
// rather than letting broad numeric coercion silently accept them.
const positiveInteger = (max: number) => z.union([z.number(), z.string().regex(/^[1-9][0-9]*$/)])
  .transform((value) => Number(value))
  .pipe(z.number().int().positive().max(max));
export const PaginationQuerySchema = z.object({
  page: positiveInteger(100000).default(1),
  pageSize: positiveInteger(50).default(10),
}).strict();
export const PaginationMetaSchema = z.object({
  page: z.number().int().min(1).max(100000),
  pageSize: z.number().int().min(1).max(50),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const HealthResponseSchema = z.object({
  status: z.literal('ok'), service: z.literal('flowpilot-api'),
}).strict();
export const ApiErrorSchema = z.object({
  code: z.string().min(1), message: z.string().min(1), traceId: z.string().min(1),
}).strict();

export type IdParams = z.infer<typeof IdParamsSchema>;
export type IdempotencyHeaders = z.infer<typeof IdempotencyHeadersSchema>;
export type PaginationQueryInput = z.input<typeof PaginationQuerySchema>;
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

