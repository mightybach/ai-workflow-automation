import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDatabaseClient, type Prisma } from '@flowpilot/db';
import { buildApp } from './app.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use the isolated local test database.');
test('Phase 7 schema enforces scoped workflow identity, state and atomic task coverage', async (t) => {
  const db = createDatabaseClient(url); const now = new Date('2030-01-07T22:00:00Z'); const later = new Date(+now + 1000); const tag = randomUUID();
  const app = buildApp({ db, clock: () => now });
  const businesses = await Promise.all(['a', 'b'].map((suffix) => db.business.create({ data: { slug: `workflow-schema-${tag}-${suffix}`, name: 'Synthetic workflow business' } })));
  const a = businesses[0]!; const b = businesses[1]!; const ids = businesses.map((row) => row.id);
  const members: Prisma.BusinessMembershipGetPayload<object>[] = [];
  for (const [businessId, role] of [[a.id, 'OWNER'], [a.id, 'STAFF'], [b.id, 'OWNER']] as const) {
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic-not-used-for-login', role: 'CLIENT' } });
    members.push(await db.businessMembership.create({ data: { businessId, userId: user.id, role } }));
  }
  t.after(async () => {
    await app.close();
    try { await db.$transaction(async (tx) => {
      const where = { businessId: { in: ids } };
      await tx.businessWorkflowAction.deleteMany({ where }); await tx.businessTask.deleteMany({ where }); await tx.businessWorkflowRun.deleteMany({ where }); await tx.businessWorkflowDefinition.deleteMany({ where });
      await tx.notificationOutbox.deleteMany({ where }); await tx.auditEvent.deleteMany({ where }); await tx.bookingAction.deleteMany({ where });
      await tx.bookingSlot.deleteMany({ where }); await tx.booking.deleteMany({ where }); await tx.bookingProposal.deleteMany({ where }); await tx.customerSession.deleteMany({ where });
      await tx.availabilitySlot.deleteMany({ where }); await tx.staff.deleteMany({ where }); await tx.service.deleteMany({ where }); await tx.businessMembership.deleteMany({ where });
      await tx.user.deleteMany({ where: { id: { in: members.map((row) => row.userId) } } }); await tx.business.deleteMany({ where: { id: { in: ids } } });
    }); } finally { await db.$disconnect(); }
  });
  const definitions = await Promise.all(ids.map((businessId) => db.businessWorkflowDefinition.create({ data: { businessId, template: 'PREPARE_APPOINTMENT', createdAt: now, updatedAt: now } })));
  const enable = (index: number, activationId: string = randomUUID()) => db.businessWorkflowDefinition.update({ where: { id: definitions[index]!.id }, data: { enabled: true, revision: { increment: 1 }, activationId, enabledAt: now, updatedAt: now } });
  let definition = definitions[0]!;
  let day = 0; let request = 1;
  const book = async (index = 0) => {
    const businessId = ids[index]!; const suffix = randomUUID();
    const staff = await db.staff.create({ data: { businessId, slug: suffix, displayName: 'Synthetic staff' } });
    const service = await db.service.create({ data: { businessId, slug: suffix, name: 'Synthetic service' } });
    const startAt = new Date(Date.parse('2030-01-08T00:00:00Z') + day++ * 86400000);
    const slot = await db.availabilitySlot.create({ data: { businessId, staffId: staff.id, startAt, endAt: new Date(+startAt + 1800000) } });
    const headers = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };
    const session = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers, payload: { businessSlug: businesses[index]!.slug } }); assert.equal(session.statusCode, 201);
    const cookie = String(session.headers['set-cookie']).split(';')[0]!;
    const post = (path: string, payload: object) => app.inject({ method: 'POST', url: '/api/v1/customer/' + path, remoteAddress: `127.0.40.${request++}`, headers: { ...headers, cookie, 'idempotency-key': randomUUID() }, payload });
    const proposal = await post('booking-proposals', { slotId: slot.id, serviceId: service.id, durationMinutes: 30 }); assert.equal(proposal.statusCode, 201, proposal.body);
    const saved = await post('bookings', { proposalId: proposal.json().id, customer: { name: 'Synthetic', email: 'synthetic@example.test' } }); assert.equal(saved.statusCode, 201, saved.body);
    const event = await db.notificationOutbox.findFirstOrThrow({ where: { bookingId: saved.json().id } });
    // Runtime enrollment now exists; this schema-only fixture replaces its own
    // pending enrollment to exercise the lower-level insertion guards.
    await db.businessWorkflowRun.deleteMany({ where: { businessId, bookingId: event.bookingId } });
    return { bookingId: event.bookingId, eventId: event.id, startAt };
  };
  const enrollment = (booking: Awaited<ReturnType<typeof book>>, overrides: Partial<Prisma.BusinessWorkflowRunUncheckedCreateInput> = {}) => ({
    businessId: a.id, definitionId: definition.id, bookingId: booking.bookingId, triggerEventId: booking.eventId,
    activationId: definition.activationId!, policyRevision: definition.revision, createdAt: now, availableAt: now, ...overrides,
  });
  const execute = async (booking: Awaited<ReturnType<typeof book>>) => {
    const run = await db.businessWorkflowRun.create({ data: enrollment(booking) });
    const data = { businessId: a.id, definitionId: definition.id, bookingId: booking.bookingId, runId: run.id, kind: 'PREPARE_APPOINTMENT' as const, dueAt: booking.startAt, createdAt: now, updatedAt: now };
    await assert.rejects(db.businessTask.create({ data })); // A run without a worker lease is insufficient.
    await db.businessWorkflowRun.update({ where: { id: run.id }, data: { attempts: 1, leaseToken: randomUUID(), leaseExpiresAt: new Date(+now + 30000) } });
    await assert.rejects(db.businessTask.create({ data: { ...data, dueAt: new Date(+booking.startAt + 1800000) } }));
    await assert.rejects(db.businessTask.create({ data })); // Cannot commit an orphan task.
    await assert.rejects(db.businessWorkflowRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', resultCode: 'TASK_CREATED', finishedAt: later, leaseToken: null, leaseExpiresAt: null } })); // Cannot commit success without task.
    return db.$transaction(async (tx) => {
      const task = await tx.businessTask.create({ data });
      await tx.businessWorkflowRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', resultCode: 'TASK_CREATED', finishedAt: later, leaseToken: null, leaseExpiresAt: null } });
      return task;
    });
  };
  await t.test('definitions start disabled; activation revisions cannot be reused across enable cycles', async () => {
    assert.equal(definition.enabled, false); assert.equal(definition.activationId, null);
    await assert.rejects(db.businessWorkflowDefinition.create({ data: { businessId: a.id, template: 'PREPARE_APPOINTMENT' } }));
    await assert.rejects(db.businessWorkflowDefinition.update({ where: { id: definition.id }, data: { enabled: true } }));
    const oldBooking = await book(); await assert.rejects(db.businessWorkflowRun.create({ data: enrollment(oldBooking, { activationId: randomUUID() }) }));
    definition = await enable(0); await enable(1);
    await assert.rejects(db.businessWorkflowDefinition.update({ where: { id: definition.id }, data: { businessId: b.id } }));
    await db.businessWorkflowDefinition.update({ where: { id: definition.id }, data: { enabled: false, revision: { increment: 1 }, updatedAt: now } });
    await assert.rejects(enable(0, definition.activationId!));
    const previous = definition.activationId; definition = await enable(0); assert.notEqual(definition.activationId, previous);
  });
  await t.test('enrollment binds business, booking, event, activation and immutable identity', async () => {
    const booking = await book(); const other = await book(1);
    for (const patch of [{ businessId: b.id }, { bookingId: other.bookingId }, { triggerEventId: other.eventId }, { definitionId: definitions[1]!.id }, { activationId: randomUUID() }, { policyRevision: 1 }, { attempts: 1 }, { status: 'SUCCEEDED' as const }]) {
      await assert.rejects(db.businessWorkflowRun.create({ data: enrollment(booking, patch) }));
    }
    const run = await db.businessWorkflowRun.create({ data: enrollment(booking) });
    await assert.rejects(db.businessWorkflowRun.create({ data: enrollment(booking) }));
    for (const patch of [{ activationId: randomUUID() }, { bookingId: other.bookingId }, { attempts: 6 }, { leaseToken: randomUUID() }, { lastErrorCode: 'private raw text' }]) await assert.rejects(db.businessWorkflowRun.update({ where: { id: run.id }, data: patch }));
    await db.businessWorkflowRun.update({ where: { id: run.id }, data: { status: 'SUPPRESSED', resultCode: 'WORKFLOW_DISABLED', finishedAt: later } });
    await assert.rejects(db.businessWorkflowRun.update({ where: { id: run.id }, data: { status: 'PENDING', finishedAt: null, resultCode: null } }));
  });
  await t.test('task and successful run commit together; due time, tenant and completion history stay protected', async () => {
    const booking = await book(); const task = await execute(booking);
    await assert.rejects(db.businessTask.delete({ where: { id: task.id } }));
    for (const patch of [{ dueAt: new Date(+task.dueAt + 1800000) }, { businessId: b.id }, { status: 'COMPLETED' as const, revision: 2 }, { status: 'CANCELLED' as const, revision: 2 }]) await assert.rejects(db.businessTask.update({ where: { id: task.id }, data: patch }));
    await assert.rejects(db.businessTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', revision: 2, completedAt: later, completedByMembershipId: members[2]!.id, updatedAt: later } }));
    await db.businessMembership.update({ where: { id: members[1]!.id }, data: { active: false } });
    await assert.rejects(db.businessTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', revision: 2, completedAt: later, completedByMembershipId: members[1]!.id, updatedAt: later } }));
    await db.businessMembership.update({ where: { id: members[1]!.id }, data: { active: true } });
    const complete = await db.businessTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', revision: 2, completedAt: later, completedByMembershipId: members[1]!.id, updatedAt: later } });
    await assert.rejects(db.businessTask.update({ where: { id: task.id }, data: { status: 'OPEN', revision: 3, completedAt: null, completedByMembershipId: null, updatedAt: later } }));
    const invalidated = await db.businessTask.update({ where: { id: task.id }, data: { revision: 3, invalidatedAt: later, invalidationReason: 'BOOKING_CANCELLED', updatedAt: later } });
    assert.equal(+invalidated.completedAt!, +complete.completedAt!); assert.equal(invalidated.completedByMembershipId, complete.completedByMembershipId);
    await assert.rejects(db.businessTask.update({ where: { id: task.id }, data: { revision: 4, invalidatedAt: null, invalidationReason: null, updatedAt: later } }));
  });
  await t.test('workflow actions enforce actor role, typed target, stable keys and immutable response', async () => {
    const data = { businessId: a.id, membershipId: members[0]!.id, definitionId: definition.id, operation: 'SET_POLICY' as const, idempotencyKey: randomUUID(), requestFingerprint: 'a'.repeat(64), response: { enabled: true, revision: definition.revision } };
    await assert.rejects(db.businessWorkflowAction.create({ data: { ...data, membershipId: members[1]!.id } }));
    await assert.rejects(db.businessWorkflowAction.create({ data: { ...data, membershipId: members[2]!.id } }));
    await assert.rejects(db.businessWorkflowAction.create({ data: { ...data, operation: 'COMPLETE_TASK' } }));
    await assert.rejects(db.businessWorkflowAction.create({ data: { ...data, requestFingerprint: 'raw text' } }));
    const action = await db.businessWorkflowAction.create({ data });
    await assert.rejects(db.businessWorkflowAction.create({ data }));
    await assert.rejects(db.businessWorkflowAction.update({ where: { id: action.id }, data: { response: {} } }));
  });
});
