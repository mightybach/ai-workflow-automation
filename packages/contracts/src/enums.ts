import { z } from 'zod';

export const RoleSchema = z.enum(['ADMIN', 'REVIEWER', 'CLIENT']);
export const WorkflowCategorySchema = z.enum([
  'REFUND_REQUEST', 'TECHNICAL_SUPPORT', 'INVOICE_REQUEST', 'GENERAL_QUESTION', 'OTHER',
]);
export const WorkflowStatusSchema = z.enum([
  'PENDING', 'RUNNING', 'AWAITING_APPROVAL', 'NEEDS_REVIEW',
  'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED',
]);
export const ActorTypeSchema = z.enum(['USER', 'SYSTEM', 'WORKER']);
export const OrderStatusSchema = z.enum(['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']);

export type Role = z.infer<typeof RoleSchema>;
export type WorkflowCategory = z.infer<typeof WorkflowCategorySchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type ActorType = z.infer<typeof ActorTypeSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

