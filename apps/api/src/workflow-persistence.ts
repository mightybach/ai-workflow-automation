import { randomUUID } from 'node:crypto';
import { Prisma } from '@flowpilot/db';

// Called only from a trusted booking transaction after its lifecycle event.
export async function enrollPreparation(tx: Prisma.TransactionClient, event: { id: string; businessId: string; bookingId: string; occurredAt: Date; eventType: string }) {
  if (!['BOOKING_CONFIRMED', 'BOOKING_RESCHEDULED'].includes(event.eventType)) return;
  const definition = await tx.businessWorkflowDefinition.findUnique({ where: { businessId_template: { businessId: event.businessId, template: 'PREPARE_APPOINTMENT' } } });
  if (!definition?.enabled) return;
  await tx.businessWorkflowRun.create({ data: { businessId: event.businessId, definitionId: definition.id, bookingId: event.bookingId,
    triggerEventId: event.id, activationId: definition.activationId!, policyRevision: definition.revision, createdAt: event.occurredAt, availableAt: event.occurredAt } });
}
// Caller holds the business lock. Invalidating work is part of booking/policy
// mutation, not eventual notification delivery. Never delete task history.
export async function invalidateWorkflowWork(tx: Prisma.TransactionClient, businessId: string, scope: { bookingId?: string; definitionId?: string }, reason: 'BOOKING_CANCELLED' | 'BOOKING_RESCHEDULED' | 'WORKFLOW_DISABLED', now: Date, traceId: string = randomUUID()) {
  const where = { businessId, ...scope };
  const runs = await tx.businessWorkflowRun.updateMany({ where: { ...where, status: 'PENDING' }, data: { status: 'SUPPRESSED', resultCode: reason === 'WORKFLOW_DISABLED' ? 'WORKFLOW_DISABLED' : 'BOOKING_CHANGED',
    finishedAt: now, leaseToken: null, leaseExpiresAt: null, lastErrorCode: null } });
  const open = await tx.businessTask.updateMany({ where: { ...where, status: 'OPEN' }, data: { status: 'CANCELLED', closedAt: now, revision: { increment: 1 }, updatedAt: now } });
  const complete = await tx.businessTask.updateMany({ where: { ...where, status: 'COMPLETED', invalidatedAt: null }, data: { invalidatedAt: now, invalidationReason: reason, revision: { increment: 1 }, updatedAt: now } });
  if (runs.count + open.count + complete.count) await tx.auditEvent.create({ data: { businessId, entityType: scope.bookingId ? 'Booking' : 'BusinessWorkflowDefinition', entityId: scope.bookingId ?? scope.definitionId!,
    actorType: 'SYSTEM', actorId: null, eventType: 'WORKFLOW_WORK_INVALIDATED', traceId, metadata: { reason, runs: runs.count, tasks: open.count + complete.count }, createdAt: now } });
}
