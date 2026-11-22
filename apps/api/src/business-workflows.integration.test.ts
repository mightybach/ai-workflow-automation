import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDatabaseClient, hashPassword, businessDate } from '@flowpilot/db';
import { buildApp } from './app.js';
import { claimWorkflowRun, executeWorkflowRun, workflowBatch } from './workflow-executor.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use the isolated local test database.');
test('Phase 7 preparation and staff-recorded enquiry workflows', async (t) => {
  const db = createDatabaseClient(url); const tag = randomUUID(); let reference = Date.parse('2030-01-07T22:00Z'); const clock = () => new Date(reference);
  const app = buildApp({ db, clock, demoAuthEnabled: true }); const restart = buildApp({ db, clock, demoAuthEnabled: true });
  const businesses = await Promise.all(['a', 'b'].map((suffix) => db.business.create({ data: { slug: `workflows-${tag}-${suffix}`, name: 'Synthetic workflows' } }))); const a = businesses[0]!; const ids = businesses.map((row) => row.id);
  const members: { id: string; userId: string }[] = []; const cookies: string[] = []; const password = 'synthetic-workflow-password'; const hash = await hashPassword(password);
  const headers = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };
  for (const [businessId, role] of [[ids[0]!, 'OWNER'], [ids[0]!, 'STAFF'], [ids[1]!, 'OWNER']] as const) {
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: hash, role: 'CLIENT' } });
    members.push(await db.businessMembership.create({ data: { userId: user.id, businessId, role } }));
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: user.email, password } }); assert.equal(login.statusCode, 200); cookies.push(String(login.headers['set-cookie']).split(';')[0]!);
  }
  t.after(async () => { await app.close(); await restart.close(); try { await db.$transaction(async (tx) => {
    const where = { businessId: { in: ids } }; await tx.businessWorkflowAction.deleteMany({ where }); await tx.businessTask.deleteMany({ where }); await tx.businessWorkflowRun.deleteMany({ where }); await tx.businessWorkflowDefinition.deleteMany({ where });
    await tx.notificationOutbox.deleteMany({ where }); await tx.auditEvent.deleteMany({ where }); await tx.bookingAction.deleteMany({ where }); await tx.bookingSlot.deleteMany({ where }); await tx.booking.deleteMany({ where }); await tx.bookingProposal.deleteMany({ where });
    await tx.customerSession.deleteMany({ where }); await tx.availabilitySlot.deleteMany({ where }); await tx.staff.deleteMany({ where }); await tx.service.deleteMany({ where });
    await tx.session.deleteMany({ where: { userId: { in: members.map((row) => row.userId) } } }); await tx.businessMembership.deleteMany({ where }); await tx.user.deleteMany({ where: { id: { in: members.map((row) => row.userId) } } }); await tx.business.deleteMany({ where: { id: { in: ids } } });
  }); } finally { await db.$disconnect(); } });
  let ip = 1; let day = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, body?: object, index = 0, key: string = randomUUID(), server = app) => server.inject({ method, url: '/api/v1' + path, remoteAddress: `127.0.60.${ip++}`, headers: { ...headers, cookie: cookies[index]!, 'idempotency-key': key }, ...(body ? { payload: body } : {}) });
  const policy = async (template: string, index = 0) => { const response = await call('GET', '/admin/workflows', undefined, index); assert.equal(response.statusCode, 200); return response.json().items.find((row: { template: string }) => row.template === template) as { id: string; revision: number; enabled: boolean }; };
  const setPolicy = async (template: string, enabled: boolean) => { const row = await policy(template); const response = await call('PUT', `/admin/workflows/${row.id}`, { enabled, expectedRevision: row.revision }); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  const worker = () => workflowBatch(db, { businessId: a.id, limit: 100, clock });
  const tasks = (bookingId: string) => db.businessTask.findMany({ where: { businessId: a.id, bookingId }, orderBy: { kind: 'asc' } });
  const book = async (index = 0) => {
    const businessId = ids[index]!; const suffix = randomUUID(); const staff = await db.staff.create({ data: { businessId, slug: suffix, displayName: 'Alex' } });
    const service = await db.service.create({ data: { businessId, slug: suffix, name: 'Haircut' } }); const startAt = new Date(Date.parse('2030-01-08T00:00Z') + day++ * 86400000);
    const slots = []; for (let n = 0; n < 4; n++) slots.push(await db.availabilitySlot.create({ data: { businessId, staffId: staff.id, startAt: new Date(+startAt + n * 1800000), endAt: new Date(+startAt + (n + 1) * 1800000) } }));
    const session = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', remoteAddress: `127.0.62.${ip++}`, headers, payload: { businessSlug: businesses[index]!.slug } }); assert.equal(session.statusCode, 201);
    const cookie = String(session.headers['set-cookie']).split(';')[0]!;
    const post = (path: string, body: object, key: string = randomUUID()) => app.inject({ method: 'POST', url: '/api/v1/customer/' + path, remoteAddress: `127.0.61.${ip++}`, headers: { ...headers, cookie, 'idempotency-key': key }, payload: body });
    const proposal = await post('booking-proposals', { slotId: slots[0]!.id, serviceId: service.id, durationMinutes: 30 }); assert.equal(proposal.statusCode, 201);
    const key = randomUUID(); const body = { proposalId: proposal.json().id, customer: { name: 'Synthetic', email: 'workflow@example.test' } };
    const saved = await post('bookings', body, key); assert.equal(saved.statusCode, 201, saved.body);
    return { id: saved.json().id as string, post, body, key, slots, service, startAt };
  };
  await t.test('policies default disabled, OWNER-only, no historical backfill; strict tenant/session boundaries', async () => {
    const before = await book(); const row = await policy('PREPARE_APPOINTMENT'); assert.equal(row.enabled, false);
    assert.equal(await db.businessWorkflowRun.count({ where: { businessId: a.id } }), 0);
    assert.equal((await call('PUT', `/admin/workflows/${row.id}`, { enabled: true, expectedRevision: 1 }, 1)).statusCode, 403);
    assert.equal((await call('PUT', `/admin/workflows/${row.id}`, { enabled: true, expectedRevision: 1, businessId: ids[1] })).statusCode, 400);
    assert.equal((await call('PUT', `/admin/workflows/${row.id}`, { enabled: true, expectedRevision: 1 }, 2)).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/workflows' })).statusCode, 401);
    await setPolicy('PREPARE_APPOINTMENT', true); assert.equal(await db.businessWorkflowRun.count({ where: { bookingId: before.id } }), 0);
  });
  await t.test('atomic enrollment, booking replay and concurrent workers create one task independent of broker delivery', async () => {
    const value = await book(); const event = await db.notificationOutbox.findFirstOrThrow({ where: { bookingId: value.id } }); assert.equal(event.status, 'PENDING');
    assert.equal((await value.post('bookings', value.body, value.key)).statusCode, 200);
    await Promise.all([worker(), worker()]); const rows = await tasks(value.id); assert.equal(rows.length, 1); assert.equal(rows[0]!.kind, 'PREPARE_APPOINTMENT');
    assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: event.id } })).status, 'PENDING');
    const read = await call('GET', `/admin/tasks/${rows[0]!.id}`, undefined, 1); assert.equal(read.statusCode, 200); assert.equal(read.body.includes('workflow@example.test'), false);
    const filtered = await call('GET', '/admin/tasks?date=' + businessDate(value.startAt, a.timezone) + '&status=OPEN'); assert.equal(filtered.statusCode, 200); assert.equal(filtered.json().pagination.total, 1);
    assert.equal((await call('GET', `/admin/tasks/${rows[0]!.id}`, undefined, 2)).statusCode, 404);
    assert.equal((await call('GET', '/admin/tasks?businessId=' + a.id)).statusCode, 400);
  });
  await t.test('STAFF completion is explicit, versioned, idempotent across restart, and rechecks live membership', async () => {
    const value = await book(); await worker(); const task = (await tasks(value.id))[0]!; const key = randomUUID(); const body = { expectedRevision: task.revision };
    const done = await call('POST', `/admin/tasks/${task.id}/complete`, body, 1, key); assert.equal(done.statusCode, 200, done.body); assert.equal(done.json().status, 'COMPLETED');
    assert.equal((await call('POST', `/admin/tasks/${task.id}/complete`, body, 1, key, restart)).statusCode, 200);
    assert.equal((await call('POST', `/admin/tasks/${task.id}/complete`, { expectedRevision: 999 }, 1, key)).statusCode, 409);
    await db.businessMembership.update({ where: { id: members[1]!.id }, data: { active: false } });
    assert.equal((await call('POST', `/admin/tasks/${task.id}/complete`, body, 1, key)).statusCode, 403);
    await db.businessMembership.update({ where: { id: members[1]!.id }, data: { active: true } });
  });
  await t.test('cancel/completion race preserves history and original cleanup; rescheduling enrolls only replacement preparation', async () => {
    const value = await book(); await worker(); const task = (await tasks(value.id))[0]!;
    const results = await Promise.all([call('POST', `/admin/tasks/${task.id}/complete`, { expectedRevision: task.revision }, 1), value.post(`bookings/${value.id}/cancel`, {})]);
    assert.ok([200, 409].includes(results[0]!.statusCode)); assert.equal(results[1]!.statusCode, 200);
    const changed = (await tasks(value.id))[0]!; assert.ok(changed.status === 'CANCELLED' || changed.status === 'COMPLETED' && changed.invalidatedAt !== null);
    const source = await book(); await worker(); const originalTask = (await tasks(source.id))[0]!;
    assert.equal((await call('POST', `/admin/tasks/${originalTask.id}/complete`, { expectedRevision: originalTask.revision }, 1)).statusCode, 200);
    const proposed = await source.post(`bookings/${source.id}/reschedule-proposals`, { slotId: source.slots[1]!.id, serviceId: source.service.id, durationMinutes: 30 }); assert.equal(proposed.statusCode, 201);
    const moved = await source.post(`bookings/${source.id}/reschedule`, { proposalId: proposed.json().id }); assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((await tasks(source.id))[0]!.invalidationReason, 'BOOKING_RESCHEDULED');
    await worker(); assert.equal((await tasks(moved.json().id)).length, 1);
  });
  await t.test('disable suppresses claimed/pending runs, cancels open work and re-enable cannot revive old activation', async () => {
    const open = await book(); await worker(); const queued = await book();
    const claim = await claimWorkflowRun(db, { businessId: a.id, clock }); assert.equal(claim?.kind, 'claimed');
    await setPolicy('PREPARE_APPOINTMENT', false); assert.equal((await tasks(open.id))[0]!.status, 'CANCELLED');
    await setPolicy('PREPARE_APPOINTMENT', true);
    if (claim?.kind === 'claimed') assert.equal(await executeWorkflowRun(db, claim.run, clock), 'lost');
    await worker(); assert.equal((await tasks(queued.id)).length, 0);
    const fresh = await book(); await worker(); assert.equal((await tasks(fresh.id)).length, 1);
  });
  await t.test('expired leases recover and stale owners cannot finish; started tasks expire without changing bookings', async () => {
    const value = await book(); const first = await claimWorkflowRun(db, { businessId: a.id, clock }); assert.equal(first?.kind, 'claimed');
    reference += 30_000; const next = await claimWorkflowRun(db, { businessId: a.id, clock }); assert.equal(next?.kind, 'claimed');
    if (first?.kind === 'claimed' && next?.kind === 'claimed') {
      assert.equal(first.run.id, next.run.id); assert.notEqual(first.run.leaseToken, next.run.leaseToken);
      assert.equal(await executeWorkflowRun(db, first.run, clock), 'lost'); assert.equal(await executeWorkflowRun(db, next.run, clock), 'created');
    }
    const task = (await tasks(value.id))[0]!;
    await workflowBatch(db, { businessId: a.id, clock: () => value.startAt, limit: 100 });
    assert.equal((await tasks(value.id))[0]!.status, 'EXPIRED');
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: value.id } })).status, 'CONFIRMED');
    assert.equal((await call('POST', `/admin/tasks/${task.id}/complete`, { expectedRevision: task.revision })).statusCode, 409);
  });
  await t.test('second scenario requires enabled policy, explicit trusted enquiry, creates once and inherits lifecycle cleanup', async () => {
    const value = await book();
    assert.equal((await call('POST', `/admin/bookings/${value.id}/enquiry-follow-up`, { topic: 'ARRIVAL_INFORMATION' }, 1)).statusCode, 409);
    await setPolicy('FOLLOW_UP_ENQUIRY', true); reference += 1000;
    assert.equal((await call('POST', `/admin/bookings/${value.id}/enquiry-follow-up`, { topic: 'ARRIVAL_INFORMATION', message: 'raw text' }, 1)).statusCode, 400);
    assert.equal((await call('POST', `/admin/bookings/${value.id}/enquiry-follow-up`, { topic: 'ARRIVAL_INFORMATION' }, 2)).statusCode, 404);
    const key = randomUUID(); const body = { topic: 'ARRIVAL_INFORMATION' };
    const results = await Promise.all([call('POST', `/admin/bookings/${value.id}/enquiry-follow-up`, body, 1, key), call('POST', `/admin/bookings/${value.id}/enquiry-follow-up`, body, 1, key, restart)]);
    assert.ok(results.every((r) => r.statusCode === 200), results.map((r) => r.body).join('\n'));
    assert.equal(results[0]!.json().runId, results[1]!.json().runId);
    await worker(); const enquiry = (await tasks(value.id)).filter((r) => r.kind === 'FOLLOW_UP_ENQUIRY'); assert.equal(enquiry.length, 1);
    assert.equal((await call('POST', `/admin/tasks/${enquiry[0]!.id}/complete`, { expectedRevision: 1 }, 1)).statusCode, 200);
    await value.post(`bookings/${value.id}/cancel`, {}); assert.equal((await tasks(value.id)).find((r) => r.kind === 'FOLLOW_UP_ENQUIRY')!.invalidationReason, 'BOOKING_CANCELLED');
  });
  await t.test('task/audit failure rolls back effect and retries with the same run; policy retries are immutable', async () => {
    const value = await book(); const functionName = 'workflow_fault_' + tag.replaceAll('-', '');
    await db.$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."businessId" = '${a.id}'::uuid AND NEW."eventType" = 'WORKFLOW_TASK_CREATED' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${functionName} BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try { const result = await worker(); assert.ok(result.retried > 0); assert.equal((await tasks(value.id)).length, 0); }
    finally { await db.$executeRawUnsafe(`DROP TRIGGER ${functionName} ON "AuditEvent"`); await db.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`); }
    reference += 5000; await worker(); assert.equal((await tasks(value.id)).length, 1);
    const row = await policy('PREPARE_APPOINTMENT'); const key = randomUUID(); const body = { enabled: false, expectedRevision: row.revision };
    const changed = await call('PUT', `/admin/workflows/${row.id}`, body, 0, key); assert.equal(changed.statusCode, 200);
    await setPolicy('PREPARE_APPOINTMENT', true);
    const replay = await call('PUT', `/admin/workflows/${row.id}`, body, 0, key, restart); assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), changed.json()); assert.equal((await policy('PREPARE_APPOINTMENT')).enabled, true);
    const action = await db.businessWorkflowAction.findFirstOrThrow({ where: { businessId: a.id, idempotencyKey: key } }); assert.equal(action.requestFingerprint, createHash('sha256').update(JSON.stringify(['SET_POLICY', row.id, body])).digest('hex'));
  });
  await t.test('enrollment, task-completion and lifecycle audit failures preserve booking/task state atomically', async () => {
    const functionName = 'workflow_atomic_' + tag.replaceAll('-', '');
    async function fault(table: 'AuditEvent' | 'BusinessWorkflowRun', eventType: string, operation: () => Promise<void>) {
      const condition = table === 'AuditEvent' ? `AND NEW."eventType" = '${eventType}'` : '';
      await db.$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."businessId" = '${a.id}'::uuid ${condition} THEN RAISE EXCEPTION 'synthetic atomicity fault'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER ${functionName} BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      try { await operation(); } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${functionName} ON "${table}"`); await db.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`); }
    }
    const before = await db.booking.count({ where: { businessId: a.id } });
    await fault('BusinessWorkflowRun', '', async () => {
      await assert.rejects(book(), (error: unknown) => error instanceof assert.AssertionError && error.actual === 500);
      assert.equal(await db.booking.count({ where: { businessId: a.id } }), before);
    });
    const value = await book(); await worker(); const task = (await tasks(value.id))[0]!; const key = randomUUID(); const body = { expectedRevision: task.revision };
    await fault('AuditEvent', 'WORKFLOW_COMPLETE_TASK', async () => {
      assert.equal((await call('POST', `/admin/tasks/${task.id}/complete`, body, 1, key)).statusCode, 500);
      assert.equal((await tasks(value.id))[0]!.status, 'OPEN');
      assert.equal(await db.businessWorkflowAction.count({ where: { businessId: a.id, idempotencyKey: key } }), 0);
    });
    await fault('AuditEvent', 'WORKFLOW_WORK_INVALIDATED', async () => {
      assert.equal((await value.post(`bookings/${value.id}/cancel`, {})).statusCode, 500);
      assert.equal((await db.booking.findUniqueOrThrow({ where: { id: value.id } })).status, 'CONFIRMED');
      assert.equal((await tasks(value.id))[0]!.status, 'OPEN');
      assert.equal(await db.bookingSlot.count({ where: { bookingId: value.id, releasedAt: null } }), 1);
    });
    assert.equal((await call('POST', `/admin/tasks/${task.id}/complete`, body, 1, key)).statusCode, 200);
    assert.equal((await value.post(`bookings/${value.id}/cancel`, {})).statusCode, 200);
  });
  await t.test('persistent execution failures stop at five attempts and cannot create partial tasks', async () => {
    const value = await book(); const functionName = 'workflow_dead_' + tag.replaceAll('-', '');
    await db.$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."businessId" = '${a.id}'::uuid AND NEW."eventType" = 'WORKFLOW_TASK_CREATED' THEN RAISE EXCEPTION 'synthetic retry bound'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${functionName} BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try { for (let n = 0; n < 5; n++) { await worker(); reference += 100000; } }
    finally { await db.$executeRawUnsafe(`DROP TRIGGER ${functionName} ON "AuditEvent"`); await db.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`); }
    const run = await db.businessWorkflowRun.findFirstOrThrow({ where: { businessId: a.id, bookingId: value.id } });
    assert.equal(run.status, 'DEAD'); assert.equal(run.attempts, 5); assert.equal((await tasks(value.id)).length, 0);
    await worker(); assert.equal((await tasks(value.id)).length, 0);
  });
});
