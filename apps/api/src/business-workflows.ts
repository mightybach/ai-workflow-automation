import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma, businessDayBounds, type PrismaClient } from '@flowpilot/db';
import { z } from 'zod';
import { BusinessWorkflowTemplateSchema, BusinessWorkflowPoliciesSchema, BusinessWorkflowPolicySchema, BusinessTaskSchema,
  BusinessTaskListSchema, BusinessTaskListQuerySchema, SetBusinessWorkflowPolicyBodySchema, CompleteBusinessTaskBodySchema,
  RecordBusinessEnquiryBodySchema, BusinessEnquiryResultSchema, IdParamsSchema, IdempotencyHeadersSchema } from '@flowpilot/contracts';
import { adminActionId, businessAccess, lockBusinessMember, requireOwner } from './business-admin.js';
import { invalidateWorkflowWork } from './workflow-persistence.js';
import { ApiError } from './errors.js';

const templates = BusinessWorkflowTemplateSchema.options;
const includes = { booking: { include: { proposal: true } } } as const;
type Task = Prisma.BusinessTaskGetPayload<{ include: typeof includes }>;
export const workflowDefinitionId = (businessId: string, template: string) => adminActionId('business-workflow:v1', businessId, template, 'definition');
export function taskDto(task: Task) {
  const p = task.booking.proposal;
  return BusinessTaskSchema.parse({ id: task.id, bookingId: task.bookingId, kind: task.kind, status: task.status, revision: task.revision,
    dueAt: task.dueAt.toISOString(), createdAt: task.createdAt.toISOString(), completedAt: task.completedAt?.toISOString() ?? null,
    closedAt: task.closedAt?.toISOString() ?? null, invalidatedAt: task.invalidatedAt?.toISOString() ?? null, invalidationReason: task.invalidationReason,
    bookingReference: task.booking.reference, serviceName: p.serviceName, staffName: p.staffName, startAt: p.startAt.toISOString(), endAt: p.endAt.toISOString(), timezone: p.timezone });
}
function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Use the workflow form and current revision.'); return parsed.data;
}
const notFound = () => new ApiError(404, 'NOT_FOUND', 'Workflow resource not found.');

export function businessWorkflowRoutes(app: FastifyInstance, db: PrismaClient, clock: () => Date) {
  app.get('/api/v1/admin/workflows', async (request) => {
    input(z.object({}).strict(), request.query);
    return db.$transaction(async (tx) => {
      const { membership } = await businessAccess(tx, request);
      const rows = await tx.businessWorkflowDefinition.findMany({ where: { businessId: membership.businessId } });
      return BusinessWorkflowPoliciesSchema.parse({ items: templates.map((template) => {
        const row = rows.find((item) => item.template === template);
        return { id: row?.id ?? workflowDefinitionId(membership.businessId, template), template, enabled: row?.enabled ?? false, revision: row?.revision ?? 1 };
      }) });
    }, { isolationLevel: 'RepeatableRead' });
  });
  app.get('/api/v1/admin/tasks', async (request) => {
    const query = input(BusinessTaskListQuerySchema, request.query);
    return db.$transaction(async (tx) => {
      const { membership } = await businessAccess(tx, request);
      const day = query.date ? businessDayBounds(query.date, membership.business.timezone) : null;
      const where: Prisma.BusinessTaskWhereInput = { businessId: membership.businessId, ...(query.status ? { status: query.status } : {}), ...(day ? { dueAt: { gte: day.start, lt: day.end } } : {}) };
      const total = await tx.businessTask.count({ where });
      const rows = await tx.businessTask.findMany({ where, include: includes, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: query.pageSize, skip: (query.page - 1) * query.pageSize });
      return BusinessTaskListSchema.parse({ items: rows.map(taskDto), pagination: { total, page: query.page, pageSize: query.pageSize } });
    }, { isolationLevel: 'RepeatableRead' });
  });
  app.get('/api/v1/admin/tasks/:id', async (request) => {
    input(z.object({}).strict(), request.query); const { id } = input(IdParamsSchema, request.params);
    return db.$transaction(async (tx) => {
      const { membership } = await businessAccess(tx, request);
      const task = await tx.businessTask.findFirst({ where: { id, businessId: membership.businessId }, include: includes });
      if (!task) throw notFound(); return taskDto(task);
    }, { isolationLevel: 'RepeatableRead' });
  });
  for (const operation of ['SET_POLICY', 'COMPLETE_TASK', 'RECORD_ENQUIRY'] as const) {
    const path = operation === 'SET_POLICY' ? '/api/v1/admin/workflows/:id' : operation === 'COMPLETE_TASK' ? '/api/v1/admin/tasks/:id/complete' : '/api/v1/admin/bookings/:id/enquiry-follow-up';
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      input(z.object({}).strict(), request.query); const { id: rawId } = input(IdParamsSchema, request.params); const targetId = rawId.toLowerCase();
      const key = input(IdempotencyHeadersSchema, { 'idempotency-key': request.headers['idempotency-key'] })['idempotency-key'];
      const body = operation === 'SET_POLICY' ? input(SetBusinessWorkflowPolicyBodySchema, request.body) : operation === 'COMPLETE_TASK' ? input(CompleteBusinessTaskBodySchema, request.body) : input(RecordBusinessEnquiryBodySchema, request.body);
      const fingerprint = createHash('sha256').update(JSON.stringify([operation, targetId, body])).digest('hex');
      const responseSchema = operation === 'SET_POLICY' ? BusinessWorkflowPolicySchema : operation === 'COMPLETE_TASK' ? BusinessTaskSchema : BusinessEnquiryResultSchema;
      const result = await db.$transaction(async (tx) => {
        const initial = await businessAccess(tx, request); if (operation === 'SET_POLICY') requireOwner(initial);
        const access = await lockBusinessMember(tx, request, initial); if (operation === 'SET_POLICY') requireOwner(access);
        const businessId = access.membership.businessId;
        const prior = await tx.businessWorkflowAction.findUnique({ where: { businessId_membershipId_operation_idempotencyKey: { businessId, membershipId: access.membership.id, operation, idempotencyKey: key } } });
        if (prior) {
          if (prior.requestFingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different workflow action.');
          return { response: responseSchema.parse(prior.response), replayed: true };
        }
        let definitionId: string; let taskId: string | null = null; let runId: string | null = null; let response: Prisma.InputJsonObject;
        const now = clock();
        if (operation === 'SET_POLICY') {
          const policy = SetBusinessWorkflowPolicyBodySchema.parse(body);
          const existing = await tx.businessWorkflowDefinition.findFirst({ where: { id: targetId, businessId } });
          const template = existing?.template ?? templates.find((item) => workflowDefinitionId(businessId, item) === targetId);
          if (!template) throw notFound();
          let definition = existing ?? await tx.businessWorkflowDefinition.create({ data: { id: targetId, businessId, template, createdAt: now, updatedAt: now } });
          if (definition.revision !== policy.expectedRevision) throw new ApiError(409, 'WORKFLOW_CHANGED', 'Workflow changed. Refresh and review again.');
          if (definition.enabled !== policy.enabled) {
            definition = await tx.businessWorkflowDefinition.update({ where: { id: definition.id }, data: { enabled: policy.enabled, revision: { increment: 1 }, updatedAt: now,
              ...(policy.enabled ? { activationId: randomUUID(), enabledAt: now } : {}) } });
            if (!policy.enabled) await invalidateWorkflowWork(tx, businessId, { definitionId: definition.id }, 'WORKFLOW_DISABLED', now, request.id);
          }
          definitionId = definition.id;
          response = BusinessWorkflowPolicySchema.parse({ id: definition.id, template, enabled: definition.enabled, revision: definition.revision });
        } else if (operation === 'COMPLETE_TASK') {
          const task = await tx.businessTask.findFirst({ where: { id: targetId, businessId }, include: { ...includes, definition: true, run: true } });
          if (!task) throw notFound();
          const command = CompleteBusinessTaskBodySchema.parse(body);
          if (task.revision !== command.expectedRevision || task.status !== 'OPEN' || task.booking.status !== 'CONFIRMED' || task.dueAt <= now || !task.definition.enabled || task.definition.activationId !== task.run.activationId) throw new ApiError(409, 'TASK_CHANGED', 'Task or appointment changed. Refresh before continuing.');
          const saved = await tx.businessTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', revision: { increment: 1 }, completedAt: now, completedByMembershipId: access.membership.id, updatedAt: now }, include: includes });
          definitionId = task.definitionId; taskId = task.id; response = taskDto(saved);
        } else {
          const definition = await tx.businessWorkflowDefinition.findUnique({ where: { businessId_template: { businessId, template: 'FOLLOW_UP_ENQUIRY' } } });
          const booking = await tx.booking.findFirst({ where: { id: targetId, businessId }, include: { proposal: true } });
          if (!booking) throw notFound();
          if (!definition?.enabled || booking.status !== 'CONFIRMED' || booking.proposal.startAt <= now) throw new ApiError(409, 'ENQUIRY_UNAVAILABLE', 'Enable enquiry follow-up and choose a future confirmed appointment.');
          const existing = await tx.businessWorkflowRun.findUnique({ where: { businessId_definitionId_bookingId: { businessId, definitionId: definition.id, bookingId: booking.id } } });
          let run = existing;
          if (run && (run.activationId !== definition.activationId || ['SUPPRESSED', 'DEAD'].includes(run.status))) throw new ApiError(409, 'ENQUIRY_ALREADY_RECORDED', 'This booking already has historical enquiry work. It cannot be revived.');
          if (!run) {
            const event = await tx.notificationOutbox.findFirst({ where: { businessId, bookingId: booking.id, eventType: { in: ['BOOKING_CONFIRMED', 'BOOKING_RESCHEDULED'] } } });
            if (!event) throw new ApiError(409, 'ENQUIRY_UNAVAILABLE', 'This historical booking has no supported lifecycle event.');
            run = await tx.businessWorkflowRun.create({ data: { businessId, definitionId: definition.id, bookingId: booking.id, triggerEventId: event.id, activationId: definition.activationId!, policyRevision: definition.revision, createdAt: now, availableAt: now } });
          }
          definitionId = definition.id; runId = run.id;
          response = BusinessEnquiryResultSchema.parse({ runId: run.id, bookingId: booking.id, topic: 'ARRIVAL_INFORMATION' });
        }
        await tx.businessWorkflowAction.create({ data: { businessId, membershipId: access.membership.id, definitionId, taskId, runId, operation, idempotencyKey: key, requestFingerprint: fingerprint, response, createdAt: now } });
        await tx.auditEvent.create({ data: { businessId, entityType: taskId ? 'BusinessTask' : 'BusinessWorkflowDefinition', entityId: taskId ?? definitionId,
          actorType: 'USER', actorId: access.actor.id, eventType: `WORKFLOW_${operation}`, traceId: request.id, metadata: { operation }, createdAt: now } });
        return { response, replayed: false };
      }, { timeout: 10000 });
      reply.header('Idempotency-Replayed', String(result.replayed)); return responseSchema.parse(result.response);
    };
    const config = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
    if (operation === 'SET_POLICY') app.put(path, config, handler); else app.post(path, config, handler);
  }
}
