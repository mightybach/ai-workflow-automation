import { Prisma, type PrismaClient } from '@flowpilot/db';
import type { CreateRequestBody, CreateRequestResponse, RequestListQuery } from '@flowpilot/contracts';
import type { Actor } from './auth.js';
import { ApiError } from './errors.js';

export const requestInclude = { workflows: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } satisfies Prisma.RequestInclude;

export function accessScope(actor: Actor): Prisma.RequestWhereInput {
  return actor.role === 'CLIENT' ? { createdById: actor.id } : {};
}

export async function createRequest(db: PrismaClient, actor: Actor, input: CreateRequestBody, idempotencyKey: string, traceId: string): Promise<CreateRequestResponse> {
  const where = { createdById_idempotencyKey: { createdById: actor.id, idempotencyKey } };
  let record;
  try {
    record = await db.$transaction(async (tx) => {
      const existing = await tx.request.findUnique({ where, include: requestInclude });
      if (existing) return existing;
      const created = await tx.request.create({
        data: { rawText: input.rawText, createdById: actor.id, idempotencyKey, workflows: { create: {} } },
        include: requestInclude,
      });
      await tx.auditEvent.create({ data: {
        runId: created.workflows[0]!.id, actorType: 'USER', actorId: actor.id,
        eventType: 'REQUEST_CREATED', traceId,
      } });
      return created;
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    // A concurrent transaction won the database unique constraint.
    const winner = await db.request.findUnique({ where, include: requestInclude });
    if (!winner) throw error;
    record = winner;
  }
  if (record.rawText !== input.rawText) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This submission key was used for different text. Start a new submission.');
  const initialRun = record.workflows[0];
  if (!initialRun) throw new Error('Persisted request is missing its initial workflow.');
  return { requestId: record.id, workflowRunId: initialRun.id, status: initialRun.status };
}

export async function listRequests(db: PrismaClient, actor: Actor, query: RequestListQuery): Promise<{
  items: Prisma.RequestGetPayload<{ include: typeof requestInclude }>[];
  pagination: { page: number; pageSize: number; total: number };
}> {
  const where: Prisma.RequestWhereInput = {
    ...accessScope(actor),
    ...(query.search ? { rawText: { contains: query.search, mode: 'insensitive' } } : {}),
    ...(query.status || query.category ? { workflows: { some: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
    } } } : {}),
  };
  const [items, total] = await db.$transaction([
    db.request.findMany({ where, include: requestInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.request.count({ where }),
  ], { isolationLevel: 'RepeatableRead' });
  return { items, pagination: { page: query.page, pageSize: query.pageSize, total } };
}

