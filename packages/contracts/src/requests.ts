import { z } from 'zod';
import { IdSchema, PaginationMetaSchema, PaginationQuerySchema, TimestampSchema } from './common.js';
import { WorkflowCategorySchema, WorkflowStatusSchema } from './enums.js';
import { WorkflowSummarySchema } from './workflows.js';

// Preserve original text for evidence and payload comparison; only reject
// messages that are entirely whitespace. Identity/status are server-owned.
export const CreateRequestBodySchema = z.object({
  rawText: z.string().min(1).max(10000).refine((value) => value.trim().length > 0, 'Enter a request message.'),
}).strict();

export const CreateRequestResponseSchema = z.object({
  requestId: IdSchema,
  workflowRunId: IdSchema,
  status: WorkflowStatusSchema,
}).strict();

export const RequestSummarySchema = z.object({
  id: IdSchema,
  createdById: IdSchema,
  createdAt: TimestampSchema,
  workflows: z.array(WorkflowSummarySchema),
}).strict();

export const RequestDetailSchema = RequestSummarySchema.extend({
  rawText: z.string().min(1).max(10000),
}).strict();

export const RequestListQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().min(1).max(200).optional(),
  status: WorkflowStatusSchema.optional(),
  category: WorkflowCategorySchema.optional(),
}).strict();

export const RequestListResponseSchema = z.object({
  items: z.array(RequestSummarySchema).max(50),
  pagination: PaginationMetaSchema,
}).strict();

export type CreateRequestBody = z.infer<typeof CreateRequestBodySchema>;
export type CreateRequestResponse = z.infer<typeof CreateRequestResponseSchema>;
export type RequestSummary = z.infer<typeof RequestSummarySchema>;
export type RequestDetail = z.infer<typeof RequestDetailSchema>;
export type RequestListQueryInput = z.input<typeof RequestListQuerySchema>;
export type RequestListQuery = z.infer<typeof RequestListQuerySchema>;
export type RequestListResponse = z.infer<typeof RequestListResponseSchema>;

