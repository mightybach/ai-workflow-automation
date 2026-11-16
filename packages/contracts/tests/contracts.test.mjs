import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ActorTypeSchema, ApiErrorSchema, AuditEventResponseSchema, CreateRequestBodySchema,
  CreateRequestResponseSchema, IdempotencyHeadersSchema, IdParamsSchema,
  MockOrderResponseSchema, MoneyAmountSchema, OrderStatusSchema, RequestDetailSchema,
  RequestListQuerySchema, RequestListResponseSchema, RoleSchema, UserResponseSchema,
  WorkflowCategorySchema, WorkflowResponseSchema, WorkflowStatusSchema, LoginBodySchema, SessionResponseSchema,
  AdminSlotQuerySchema, BusinessDateSchema, BusinessRoleSchema, BusinessTimezoneSchema, SlotStateSchema, AvailabilitySlotSchema,
} from '../dist/index.js';

const id = 'c27a63c1-2459-47bb-8d5c-f3fc15bd1ddd';
const runId = '8c21b672-d7ac-4dd1-805d-bd37bad90483';
const timestamp = '2026-11-13T02:00:00.000Z';
const summary = { id: runId, category: null, status: 'PENDING', version: 0 };
const request = { id, createdById: id, createdAt: timestamp, workflows: [summary] };
const user = { id, email: 'reviewer@flowpilot.test', role: 'REVIEWER', isActive: true, createdAt: timestamp, updatedAt: timestamp };

test('login normalizes email, preserves passwords and rejects claimed roles', () => {
  assert.deepEqual(LoginBodySchema.parse({ email: '  CLIENT@flowpilot.test ', password: ' keep spaces ' }),
    { email: 'client@flowpilot.test', password: ' keep spaces ' });
  assert.equal(LoginBodySchema.safeParse({ email: user.email, password: 'test', role: 'ADMIN' }).success, false);
  assert.equal(LoginBodySchema.safeParse({ email: user.email, password: '' }).success, false);
  assert.equal(SessionResponseSchema.safeParse({ user: { ...user, passwordHash: 'secret' } }).success, false);
});

test('creation preserves original evidence but rejects blank, oversized and non-text messages', () => {
  const rawText = '  Synthetic request\n';
  assert.deepEqual(CreateRequestBodySchema.parse({ rawText }), { rawText });
  for (const invalid of ['', ' \n\t', 'x'.repeat(10001), null, 123, {}]) {
    assert.equal(CreateRequestBodySchema.safeParse({ rawText: invalid }).success, false);
  }
});

test('creation rejects attempts to supply identity, state, roles or approvals', () => {
  for (const field of ['id', 'createdById', 'role', 'status', 'workflows', 'approved', 'approvalId', 'category', 'idempotencyKey']) {
    assert.equal(CreateRequestBodySchema.safeParse({ rawText: 'Synthetic', [field]: id }).success, false);
  }
});

test('idempotency headers require one bounded stable key', () => {
  assert.equal(IdempotencyHeadersSchema.parse({ 'idempotency-key': 'demo-001:retry' })['idempotency-key'], 'demo-001:retry');
  for (const key of [undefined, '', ' ', 'x'.repeat(129), ['first', 'second'], 123, 'line\nbreak']) {
    assert.equal(IdempotencyHeadersSchema.safeParse({ 'idempotency-key': key }).success, false);
  }
});

test('pagination accepts numeric query strings and rejects broad coercion and unsupported filters', () => {
  assert.deepEqual(RequestListQuerySchema.parse({}), { page: 1, pageSize: 10 });
  assert.deepEqual(RequestListQuerySchema.parse({ page: '2', pageSize: '5', status: 'PENDING', category: 'OTHER' }),
    { page: 2, pageSize: 5, status: 'PENDING', category: 'OTHER' });
  for (const value of [null, true, false, '', ' ', '1.5', '1e2', ['1'], 0, -1, Infinity, 1.5, 100001]) {
    assert.equal(RequestListQuerySchema.safeParse({ page: value }).success, false);
  }
  for (const value of [51, '51', 0]) assert.equal(RequestListQuerySchema.safeParse({ pageSize: value }).success, false);
  for (const query of [{ status: 'APPROVED' }, { category: 'RUN_SHELL' }, { search: ' ' }, { sort: 'rawSql' }]) {
    assert.equal(RequestListQuerySchema.safeParse(query).success, false);
  }
});

test('request DTOs support multiple runs and do not expose submission keys or private text in lists', () => {
  const details = RequestDetailSchema.parse({ ...request, rawText: 'Synthetic text' });
  assert.equal(details.workflows[0].status, 'PENDING');
  assert.equal(RequestDetailSchema.safeParse({ ...details, idempotencyKey: 'private-key' }).success, false);
  assert.equal(RequestListResponseSchema.safeParse({
    items: [{ ...request, rawText: 'not a list field' }], pagination: { page: 1, pageSize: 10, total: 1 },
  }).success, false);
  assert.equal(RequestListResponseSchema.parse({
    items: [request], pagination: { page: 1, pageSize: 10, total: 1 },
  }).items.length, 1);
});

test('safe user DTO excludes credential fields', () => {
  assert.deepEqual(UserResponseSchema.parse(user), user);
  for (const field of ['password', 'passwordHash', 'sessionToken']) {
    assert.equal(UserResponseSchema.safeParse({ ...user, [field]: 'secret' }).success, false);
  }
});

test('workflow DTO uses nullable category/completion and serialized timestamps', () => {
  const workflow = { ...summary, requestId: id, createdAt: timestamp, updatedAt: timestamp, completedAt: null };
  assert.equal(WorkflowResponseSchema.parse(workflow).category, null);
  for (const patch of [{ version: -1 }, { status: 'APPROVED' }, { createdAt: new Date() }, { completedAt: 'not-a-date' }]) {
    assert.equal(WorkflowResponseSchema.safeParse({ ...workflow, ...patch }).success, false);
  }
  assert.equal(CreateRequestResponseSchema.parse({ requestId: id, workflowRunId: runId, status: 'PENDING' }).requestId, id);
  assert.equal(IdParamsSchema.safeParse({ id: 'demo-1' }).success, false);
});

test('mock money is bounded decimal text and never floating-point JSON', () => {
  for (const value of ['0.00', '79.95', '9999999999.99']) assert.equal(MoneyAmountSchema.safeParse(value).success, true);
  for (const value of [79.95, '-1.00', '1e2', '1.001', '10000000000.00', '01.00']) {
    assert.equal(MoneyAmountSchema.safeParse(value).success, false);
  }
  assert.equal(MockOrderResponseSchema.parse({
    id, orderNumber: '12345', status: 'PROCESSING', deliveredAt: null,
    totalAmount: '79.95', currency: 'AUD', createdAt: timestamp,
  }).totalAmount, '79.95');
});

test('audit actor identity is consistent and metadata is JSON', () => {
  const audit = { id, runId, actorType: 'USER', actorId: id, eventType: 'REQUEST_CREATED', traceId: 'trace-1', metadata: null, createdAt: timestamp };
  assert.equal(AuditEventResponseSchema.parse(audit).actorId, id);
  assert.equal(AuditEventResponseSchema.safeParse({ ...audit, actorId: null }).success, false);
  assert.equal(AuditEventResponseSchema.safeParse({ ...audit, actorType: 'WORKER' }).success, false);
  assert.equal(AuditEventResponseSchema.safeParse({ ...audit, actorType: 'SYSTEM', actorId: null }).success, true);
  assert.equal(AuditEventResponseSchema.safeParse({ ...audit, metadata: { invalid: undefined } }).success, false);
});

test('error envelope requires traceability and rejects arbitrary debug fields', () => {
  const error = { code: 'VALIDATION_ERROR', message: 'Invalid input.', traceId: 'trace-1' };
  assert.deepEqual(ApiErrorSchema.parse(error), error);
  assert.equal(ApiErrorSchema.safeParse({ ...error, traceId: '' }).success, false);
  assert.equal(ApiErrorSchema.safeParse({ ...error, stack: 'internal' }).success, false);
});

test('shared enums match the approved Prisma schema without importing server code into the client', () => {
  const prisma = readFileSync(new URL('../../db/prisma/schema.prisma', import.meta.url), 'utf8');
  for (const [name, contract] of [
    ['Role', RoleSchema], ['Category', WorkflowCategorySchema], ['Status', WorkflowStatusSchema],
    ['ActorType', ActorTypeSchema], ['OrderStatus', OrderStatusSchema],
    ['BusinessRole', BusinessRoleSchema], ['SlotState', SlotStateSchema],
  ]) {
    const start = prisma.indexOf('enum ' + name + ' {');
    assert.notEqual(start, -1, name + ' must exist in Prisma');
    const body = prisma.slice(prisma.indexOf('{', start) + 1, prisma.indexOf('}', start));
    const values = body.split('\n').map((line) => line.replace(/\/\/.*$/, '').trim()).filter(Boolean);
    assert.deepEqual([...contract.options].sort(), values.sort(), name + ' enum drift');
  }
});

test('business inspection rejects invalid dates, foreign scope overrides and unsupported filters', () => {
  assert.equal(BusinessDateSchema.safeParse('2028-02-29').success, true);
  for (const date of ['2026-02-30', '2026-13-01', '2026-2-03', '1900-01-01', '2101-01-01']) {
    assert.equal(BusinessDateSchema.safeParse(date).success, false);
  }
  assert.deepEqual(AdminSlotQuerySchema.parse({ date: '2026-11-16' }), { date: '2026-11-16', page: 1, pageSize: 10 });
  for (const query of [{}, { date: '2026-11-16', businessId: id }, { date: '2026-11-16', pageSize: '100' }, { date: '2026-11-16', state: 'BOOKED' }]) {
    assert.equal(AdminSlotQuerySchema.safeParse(query).success, false);
  }
  assert.equal(BusinessTimezoneSchema.safeParse('Australia/Brisbane').success, true);
  assert.equal(BusinessTimezoneSchema.safeParse('Not/A_Timezone').success, false);
});
test('slot DTOs reject durations outside the fixed inventory and audit DTOs support business subjects', () => {
  const slot = { id, businessId: id, staffId: runId, startAt: '2026-11-15T23:00:00.000Z', endAt: '2026-11-15T23:30:00.000Z', state: 'AVAILABLE' };
  assert.equal(AvailabilitySlotSchema.safeParse(slot).success, true);
  assert.equal(AvailabilitySlotSchema.safeParse({ ...slot, endAt: '2026-11-16T00:00:00.000Z' }).success, false);
  const event = { id, runId: null, businessId: id, entityType: 'Business', entityId: id, actorType: 'SYSTEM', actorId: null, eventType: 'SETUP', traceId: 'trace', metadata: null, createdAt: timestamp };
  assert.equal(AuditEventResponseSchema.safeParse(event).success, true);
  assert.equal(AuditEventResponseSchema.safeParse({ ...event, businessId: null }).success, false);
});

