import { z } from 'zod';
import { IdSchema, TimestampSchema, PaginationQuerySchema, PaginationMetaSchema } from './common.js';
import { BusinessDateSchema } from './business.js';

export const BusinessWorkflowTemplateSchema = z.enum(['PREPARE_APPOINTMENT', 'FOLLOW_UP_ENQUIRY']);
export const BusinessWorkflowRunStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'SUPPRESSED', 'DEAD']);
export const BusinessTaskStatusSchema = z.enum(['OPEN', 'COMPLETED', 'CANCELLED', 'EXPIRED']);
export const BusinessWorkflowOperationSchema = z.enum(['SET_POLICY', 'COMPLETE_TASK', 'RECORD_ENQUIRY']);
export const BusinessWorkflowResultCodeSchema = z.enum(['TASK_CREATED', 'WORKFLOW_DISABLED', 'BUSINESS_INACTIVE', 'BOOKING_CHANGED', 'APPOINTMENT_STARTED', 'ACTIVATION_CHANGED']);
export const BusinessWorkflowErrorCodeSchema = z.enum(['PROCESSING_FAILED', 'ATTEMPTS_EXHAUSTED']);
export const BusinessTaskInvalidationReasonSchema = z.enum(['BOOKING_CANCELLED', 'BOOKING_RESCHEDULED', 'WORKFLOW_DISABLED']);

// Contract foundation only: no route is implemented in the persistence ticket.
// Business and actor identity always come from the authenticated server scope.
export const SetBusinessWorkflowPolicyBodySchema = z.object({ enabled: z.boolean(), expectedRevision: z.number().int().min(1).max(2147483647) }).strict();
export const CompleteBusinessTaskBodySchema = z.object({ expectedRevision: z.number().int().min(1).max(2147483647) }).strict();
export const RecordBusinessEnquiryBodySchema = z.object({ topic: z.literal('ARRIVAL_INFORMATION') }).strict();
export const BusinessWorkflowPolicySchema = z.object({ id: IdSchema, template: BusinessWorkflowTemplateSchema, enabled: z.boolean(), revision: z.number().int().positive() }).strict();
export const BusinessWorkflowPoliciesSchema = z.object({ items: z.array(BusinessWorkflowPolicySchema).max(2) }).strict();
export const BusinessTaskSchema = z.object({
  id: IdSchema, bookingId: IdSchema, kind: BusinessWorkflowTemplateSchema, status: BusinessTaskStatusSchema, revision: z.number().int().positive(),
  dueAt: TimestampSchema, createdAt: TimestampSchema, completedAt: TimestampSchema.nullable(), closedAt: TimestampSchema.nullable(),
  invalidatedAt: TimestampSchema.nullable(), invalidationReason: BusinessTaskInvalidationReasonSchema.nullable(),
  bookingReference: z.string().min(1).max(64), serviceName: z.string().min(1).max(160), staffName: z.string().min(1).max(120),
  startAt: TimestampSchema, endAt: TimestampSchema, timezone: z.string().min(1).max(100),
}).strict();
export const BusinessTaskListQuerySchema = PaginationQuerySchema.extend({ status: BusinessTaskStatusSchema.optional(), date: BusinessDateSchema.optional() }).strict();
export const BusinessTaskListSchema = z.object({ items: z.array(BusinessTaskSchema), pagination: PaginationMetaSchema }).strict();
export const BusinessEnquiryResultSchema = z.object({ runId: IdSchema, bookingId: IdSchema, topic: z.literal('ARRIVAL_INFORMATION') }).strict();
export const BusinessWorkflowPendingActionSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('SET_POLICY'), targetId: IdSchema, key: IdSchema, body: SetBusinessWorkflowPolicyBodySchema }).strict(),
  z.object({ operation: z.literal('COMPLETE_TASK'), targetId: IdSchema, key: IdSchema, body: CompleteBusinessTaskBodySchema }).strict(),
  z.object({ operation: z.literal('RECORD_ENQUIRY'), targetId: IdSchema, key: IdSchema, body: RecordBusinessEnquiryBodySchema }).strict(),
]);
export type BusinessTask = z.infer<typeof BusinessTaskSchema>;
export type BusinessWorkflowPolicy = z.infer<typeof BusinessWorkflowPolicySchema>;
export type BusinessWorkflowPendingAction = z.infer<typeof BusinessWorkflowPendingActionSchema>;
