import { z } from 'zod';

export const WorkflowCategorySchema = z.enum([
  'REFUND_REQUEST', 'TECHNICAL_SUPPORT', 'INVOICE_REQUEST', 'GENERAL_QUESTION', 'UNKNOWN',
]);
export const WorkflowStatusSchema = z.enum([
  'PENDING', 'RUNNING', 'AWAITING_APPROVAL', 'NEEDS_REVIEW',
  'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED',
]);
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('flowpilot-api'),
}).strict();
export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  traceId: z.string(),
}).strict();

export type WorkflowCategory = z.infer<typeof WorkflowCategorySchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;


