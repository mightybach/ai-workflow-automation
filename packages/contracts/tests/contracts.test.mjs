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


// Phase 2 contracts are specifications; no booking endpoints exist yet.
const bookingContracts = await import('../dist/index.js');
const selection = { durationMinutes: 30, businessId: id, slotId: id, serviceId: id, staffId: runId,
  serviceName: 'Haircut', staffName: 'Alex', startAt: '2026-11-18T23:00:00.000Z',
  endAt: '2026-11-18T23:30:00.000Z', timezone: 'Australia/Brisbane' };
const customer = { name: 'Synthetic Customer', email: 'demo@example.test' };

test('customer session bootstrap accepts a public slug without exposing token or caller authority', () => {
  const { CreateCustomerSessionBodySchema: body, CustomerSessionResponseSchema: response } = bookingContracts;
  assert.deepEqual(body.parse({ businessSlug: 'demo-salon' }), { businessSlug: 'demo-salon' });
  for (const value of [{ businessSlug: '../salon' }, { businessSlug: 'demo-salon', role: 'OWNER' }, { businessId: id }]) {
    assert.equal(body.safeParse(value).success, false);
  }
  const publicSession = { businessId: id, businessName: 'Demo salon', timezone: 'Australia/Brisbane', today: '2026-11-19', maxBookingDurationMinutes: 120, expiresAt: timestamp };
  assert.equal(response.safeParse(publicSession).success, true);
  assert.equal(response.safeParse({ ...publicSession, token: 'secret' }).success, false);
});

test('customer availability requires date/service and disallows scope and inventory-state overrides', () => {
  const schema = bookingContracts.CustomerAvailabilityQuerySchema;
  assert.deepEqual(schema.parse({ date: '2026-11-19', durationMinutes: 30, serviceId: id }), { date: '2026-11-19', durationMinutes: 30, serviceId: id, page: 1, pageSize: 10 });
  for (const patch of [{ businessId: id }, { state: 'RESERVED' }, { date: '2026-02-30' }, { pageSize: '51' }, { serviceId: undefined }]) {
    assert.equal(schema.safeParse({ date: '2026-11-19', durationMinutes: 30, serviceId: id, ...patch }).success, false);
  }
  assert.equal(bookingContracts.CustomerAvailableSlotSchema.safeParse(selection).success, true);
  for (const patch of [{ endAt: '2026-11-19T00:00:00.000Z' }, { startAt: '2026-11-18T23:01:00.000Z', endAt: '2026-11-18T23:31:00.000Z' }, { state: 'AVAILABLE' }]) {
    assert.equal(bookingContracts.CustomerAvailableSlotSchema.safeParse({ ...selection, ...patch }).success, false);
  }
});

test('proposal and confirmation inputs reject claimed consent and changed selection', () => {
  const proposal = { slotId: id, serviceId: id, durationMinutes: 30 };
  assert.deepEqual(bookingContracts.CreateBookingProposalBodySchema.parse(proposal), proposal);
  const body = { proposalId: id, customer };
  assert.deepEqual(bookingContracts.ConfirmBookingBodySchema.parse(body), body);
  for (const patch of [{ confirmed: true }, { businessId: id }, { slotId: runId }, { serviceId: runId }, { status: 'CONFIRMED' }, { sessionId: id }]) {
    assert.equal(bookingContracts.ConfirmBookingBodySchema.safeParse({ ...body, ...patch }).success, false);
  }
  assert.equal(bookingContracts.ConfirmBookingBodySchema.safeParse({ ...body, customer: { ...customer, email: 'real@example.com' } }).success, false);
  assert.equal(bookingContracts.ConfirmBookingBodySchema.safeParse({ ...body, customer: { ...customer, name: '  ' } }).success, false);
  assert.deepEqual(bookingContracts.SyntheticCustomerSchema.parse({ name: ' Demo ', email: ' DEMO@EXAMPLE.TEST ' }), { name: 'Demo', email: 'demo@example.test' });
});

test('proposal and booking responses bound timestamps and omit private persistence fields', () => {
  const proposal = { ...selection, id, createdAt: timestamp, expiresAt: '2026-11-13T02:05:00.000Z' };
  assert.equal(bookingContracts.BookingProposalResponseSchema.safeParse(proposal).success, true);
  assert.equal(bookingContracts.BookingProposalResponseSchema.safeParse({ ...proposal, expiresAt: timestamp }).success, false);
  const booking = { ...selection, id, reference: 'FP-DEMO-001', status: 'CONFIRMED', customer, createdAt: timestamp };
  assert.equal(bookingContracts.BookingResponseSchema.safeParse(booking).success, true);
  for (const patch of [{ tokenHash: 'secret' }, { idempotencyKey: 'secret' }, { status: 'CANCELLED' }]) {
    assert.equal(bookingContracts.BookingResponseSchema.safeParse({ ...booking, ...patch }).success, false);
  }
  assert.equal(bookingContracts.BookingErrorResponseSchema.safeParse({ code: 'SLOT_UNAVAILABLE', message: 'Choose another slot.', traceId: 'trace' }).success, true);
});

test('multi-slot appointment contracts accept increments and bind end time to requested duration', () => {
  const { BookingDurationMinutesSchema, CreateBookingProposalBodySchema, CustomerAvailableSlotSchema, CustomerAvailabilityQuerySchema } = bookingContracts;
  for (const durationMinutes of [30, 60, 90, 120, 1440]) {
    assert.equal(BookingDurationMinutesSchema.safeParse(durationMinutes).success, true);
    assert.equal(CreateBookingProposalBodySchema.safeParse({ slotId: id, serviceId: id, durationMinutes }).success, true);
    assert.equal(CustomerAvailableSlotSchema.safeParse({ ...selection, durationMinutes,
      endAt: new Date(Date.parse(selection.startAt) + durationMinutes * 60000).toISOString() }).success, true);
  }
  for (const durationMinutes of [0, 15, 45, -30, 1470, 60.5, '60', null, true]) {
    assert.equal(BookingDurationMinutesSchema.safeParse(durationMinutes).success, false);
  }
  assert.equal(CustomerAvailableSlotSchema.safeParse({ ...selection, durationMinutes: 60 }).success, false);
  assert.equal(CustomerAvailabilityQuerySchema.parse({ date: '2026-11-19', serviceId: id, durationMinutes: '120' }).durationMinutes, 120);
  for (const durationMinutes of [undefined, '', '1e2', ['60'], true]) {
    assert.equal(CustomerAvailabilityQuerySchema.safeParse({ date: '2026-11-19', serviceId: id, durationMinutes }).success, false);
  }
});

test('chat and browser recovery contracts reject authority fields and forged confirmation state', () => {
  const context = { serviceId: null, staffId: null, date: null, durationMinutes: null };
  assert.equal(bookingContracts.CustomerChatBodySchema.safeParse({ message: 'Haircut tomorrow', context }).success, true);
  for (const extra of [{ businessId: id }, { confirmed: true }, { referenceTime: timestamp }]) {
    assert.equal(bookingContracts.CustomerChatBodySchema.safeParse({ message: 'Haircut', context, ...extra }).success, false);
  }
  assert.equal(bookingContracts.CustomerChatBodySchema.safeParse({ message: 'x'.repeat(1001), context }).success, false);
  const draft = { businessId: id, sessionExpiresAt: timestamp, proposal: { key: 'stable-proposal', body: { slotId: id, serviceId: runId, durationMinutes: 60 } }, confirmation: null, bookingId: null };
  assert.equal(bookingContracts.CustomerBookingDraftSchema.safeParse(draft).success, true);
  assert.equal(bookingContracts.CustomerBookingDraftSchema.safeParse({ ...draft, status: 'CONFIRMED' }).success, false);
  assert.equal(bookingContracts.CustomerBookingDraftSchema.safeParse({ ...draft, confirmation: { key: 'stable-confirm', body: { proposalId: id, customer: { name: 'Demo', email: 'demo@example.test' }, confirmed: true } } }).success, false);
});
