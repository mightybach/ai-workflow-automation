import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@flowpilot/db';
import {
  CreateRequestBodySchema, CreateRequestResponseSchema, IdempotencyHeadersSchema, IdParamsSchema,
  RequestDetailSchema, RequestListQuerySchema, RequestListResponseSchema,
} from '@flowpilot/contracts';
import { z } from 'zod';
import { authentication } from './auth.js';
import { ApiError } from './errors.js';
import { accessScope, createRequest, listRequests, requestInclude } from './request-service.js';
import { workflowDto } from './serialization.js';

function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Input does not match the API contract.');
  return result.data;
}
function summary(record: { id: string; createdById: string; createdAt: Date; workflows: { id: string; category: string | null; status: string; version: number }[] }) {
  return { id: record.id, createdById: record.createdById, createdAt: record.createdAt.toISOString(),
    workflows: record.workflows.map((run) => ({ id: run.id, category: run.category, status: run.status, version: run.version })) };
}
export function requestRoutes(app: FastifyInstance, db: PrismaClient) {
  const authenticate = authentication(db);
  app.post('/api/v1/requests', async (request, reply) => {
    const actor = await authenticate(request);
    const body = input(CreateRequestBodySchema, request.body);
    const headers = input(IdempotencyHeadersSchema, { 'idempotency-key': request.headers['idempotency-key'] });
    const result = await createRequest(db, actor, body, headers['idempotency-key'], request.id);
    reply.code(202);
    return CreateRequestResponseSchema.parse(result);
  });
  app.get('/api/v1/requests', async (request) => {
    const actor = await authenticate(request);
    const result = await listRequests(db, actor, input(RequestListQuerySchema, request.query));
    return RequestListResponseSchema.parse({ ...result, items: result.items.map(summary) });
  });
  app.get('/api/v1/requests/:id', async (request) => {
    const actor = await authenticate(request);
    const { id } = input(IdParamsSchema, request.params);
    const record = await db.request.findFirst({ where: { id, ...accessScope(actor) }, include: requestInclude });
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
    return RequestDetailSchema.parse({ ...summary(record), rawText: record.rawText });
  });
  app.get('/api/v1/workflows/:id', async (request) => {
    const actor = await authenticate(request);
    const { id } = input(IdParamsSchema, request.params);
    const run = await db.workflow.findFirst({ where: { id, request: { is: accessScope(actor) } } });
    if (!run) throw new ApiError(404, 'NOT_FOUND', 'Workflow not found.');
    return workflowDto(run);
  });
}

