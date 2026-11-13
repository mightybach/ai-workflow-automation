import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { WorkflowCategorySchema, WorkflowStatusSchema } from './enums.js';

export const WorkflowSummarySchema = z.object({
  id: IdSchema,
  category: WorkflowCategorySchema.nullable(),
  status: WorkflowStatusSchema,
  version: z.number().int().nonnegative(),
}).strict();

export const WorkflowResponseSchema = WorkflowSummarySchema.extend({
  requestId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
}).strict();

export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;

