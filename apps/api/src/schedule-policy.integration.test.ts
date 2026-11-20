import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { createDatabaseClient, hashPassword, Prisma } from '@flowpilot/db';
import { buildApp } from './app.js';
import { changeSchedulePolicy } from './schedule-policy.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use the dedicated local test database.');
const headers = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };
test('Phase 5 Step 2B dated working hours and persistent closure rules', async (t) => {
  const db = createDatabaseClient(url); const tag = randomUUID(); const clock = () => new Date('2030-01-07T22:00:00Z');
  const app = buildApp({ db, clock, demoAuthEnabled: true }); const other = buildApp({ db, clock });
  const businesses = await Promise.all(['a', 'b'].map((name) => db.business.create({ data: { slug: `policy-${tag}-${name}`, name: `Synthetic ${name}` } })));
  const a = businesses[0]!; const b = businesses[1]!; const ids = [a.id, b.id];
  const password = 'synthetic-policy-password'; const passwordHash = await hashPassword(password);
  const users = await Promise.all(['CLIENT', 'ADMIN', 'CLIENT', 'ADMIN'].map((role, index) => db.user.create({ data: { email: `policy-${tag}-${index}@example.test`, role: role as 'CLIENT' | 'ADMIN', passwordHash } })));
  await db.businessMembership.createMany({ data: [{ userId: users[0]!.id, businessId: a.id, role: 'OWNER' }, { userId: users[1]!.id, businessId: a.id, role: 'STAFF' }, { userId: users[2]!.id, businessId: b.id, role: 'OWNER' }] });
  const staff = await Promise.all(businesses.map((business) => db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } })));
  const service = await db.service.create({ data: { businessId: a.id, slug: 'haircut', name: 'Haircut' } });
  t.after(async () => {
    await app.close(); await other.close();
    try { await db.$transaction(async (tx) => {
      await tx.auditEvent.deleteMany({ where: { businessId: { in: ids } } }); await tx.notificationOutbox.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingAction.deleteMany({ where: { businessId: { in: ids } } });
      await tx.bookingSlot.deleteMany({ where: { businessId: { in: ids } } }); await tx.booking.deleteMany({ where: { businessId: { in: ids } } });
      await tx.bookingProposal.deleteMany({ where: { businessId: { in: ids } } }); await tx.customerSession.deleteMany({ where: { businessId: { in: ids } } });
      await tx.scheduleClosure.deleteMany({ where: { businessId: { in: ids } } }); await tx.availabilitySlot.deleteMany({ where: { businessId: { in: ids } } });
      await tx.service.deleteMany({ where: { businessId: { in: ids } } }); await tx.staff.deleteMany({ where: { businessId: { in: ids } } });
      await tx.businessMembership.deleteMany({ where: { businessId: { in: ids } } }); await tx.business.deleteMany({ where: { id: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    }); } finally { await db.$disconnect(); }
  });
  const cookies: string[] = [];
  for (const user of users) { const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: user.email, password } }); assert.equal(response.statusCode, 200); cookies.push(String(response.headers['set-cookie']).split(';')[0]!); }
  let ip = 1;
  const put = (kind: string, body: Record<string, unknown>, key: string = randomUUID(), actor = 0, server = app) => server.inject({ method: 'PUT', url: '/api/v1/admin/schedule/' + kind,
    remoteAddress: `127.0.3.${ip++}`, headers: { ...headers, cookie: cookies[actor]!, 'idempotency-key': key }, payload: body });
  const revision = async (businessId = a.id) => (await db.business.findUniqueOrThrow({ where: { id: businessId } })).updatedAt.toISOString();
  const window = async (startMinute: number, endMinute: number, staffId: string | null = staff[0]!.id, date = '2030-01-08') => ({ date, startMinute, endMinute, staffId, expectedUpdatedAt: await revision() });
  const reopen = async (slotIds: string[]) => app.inject({ method: 'PUT', url: '/api/v1/admin/schedule', headers: { ...headers, cookie: cookies[0]!, 'idempotency-key': randomUUID() }, payload: { slotIds, state: 'AVAILABLE', expectedUpdatedAt: await revision() } });
  const get = (actor = 0) => app.inject({ method: 'GET', url: '/api/v1/admin/schedule/policies?date=2030-01-08', headers: { cookie: cookies[actor]! } });
  let originalClosure = ''; let originalBody: Awaited<ReturnType<typeof window>>; const originalKey = randomUUID();
  await t.test('business/role/strict boundaries are enforced before any new effect', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/schedule/policies?date=2030-01-08' })).statusCode, 401);
    assert.equal((await get(3)).statusCode, 403); assert.equal((await get(1)).statusCode, 200);
    const body = await window(540, 600);
    assert.equal((await put('hours', body, randomUUID(), 1)).statusCode, 403);
    assert.equal((await put('hours', { ...body, staffId: staff[1]!.id })).statusCode, 404);
    for (const patch of [{ startMinute: 541 }, { endMinute: 540 }, { role: 'OWNER' }, { businessId: b.id }, { expectedUpdatedAt: undefined }]) assert.equal((await put('hours', { ...body, ...patch })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/schedule/hours', headers: { cookie: cookies[0]! }, payload: body })).statusCode, 403);
    await assert.rejects(db.scheduleClosure.create({ data: { businessId: a.id, staffId: staff[1]!.id, startAt: new Date('2030-01-09T00:00Z'), endAt: new Date('2030-01-09T01:00Z') } }));
  });
  await t.test('an empty-date closure persists and future generation materializes it as BLOCKED', async () => {
    originalBody = await window(540, 600, null); const closed = await put('close', originalBody, originalKey); assert.equal(closed.statusCode, 200, closed.body);
    originalClosure = closed.json().closure.id; assert.equal(closed.json().blockedCount, 0);
    const hoursBody = await window(540, 660); const key = randomUUID(); const added = await put('hours', hoursBody, key);
    assert.equal(added.statusCode, 200, added.body); assert.equal(added.json().createdCount, 4); assert.equal(added.json().blockedCount, 2);
    assert.deepEqual((await db.availabilitySlot.findMany({ where: { businessId: a.id }, orderBy: { startAt: 'asc' } })).map((slot) => slot.state), ['BLOCKED', 'BLOCKED', 'AVAILABLE', 'AVAILABLE']);
    assert.deepEqual((await put('hours', hoursBody, key, 0, other)).json(), added.json());
    assert.equal((await put('hours', await window(540, 660))).json().createdCount, 0);
    const slots = await db.availabilitySlot.findMany({ where: { businessId: a.id }, orderBy: { startAt: 'asc' } });
    assert.equal((await reopen([slots[0]!.id])).json().code, 'CLOSURE_ACTIVE');
    await assert.rejects(db.availabilitySlot.update({ where: { id: slots[0]!.id }, data: { state: 'AVAILABLE' } }));
    const jamie = await db.staff.create({ data: { businessId: a.id, slug: 'jamie', displayName: 'Jamie' } });
    for (const state of ['AVAILABLE', 'RESERVED'] as const) await assert.rejects(db.availabilitySlot.create({ data: { businessId: a.id, staffId: jamie.id, startAt: slots[0]!.startAt, endAt: slots[0]!.endAt, state } }));
  });
  await t.test('overlapping staff/business policies require every rule lifted; manual blocks are never auto-opened', async () => {
    const specific = await put('close', await window(570, 630)); assert.equal(specific.statusCode, 200); const secondId = specific.json().closure.id;
    const beforeRelease = await db.availabilitySlot.findMany({ where: { businessId: a.id, staffId: staff[0]!.id }, orderBy: { startAt: 'asc' } });
    assert.equal((await put('release', { closureId: originalClosure, expectedUpdatedAt: await revision() })).statusCode, 200);
    assert.equal((await reopen([beforeRelease[1]!.id])).json().code, 'CLOSURE_ACTIVE');
    assert.equal((await reopen([beforeRelease[0]!.id])).statusCode, 200);
    assert.equal((await put('release', { closureId: secondId, expectedUpdatedAt: await revision() })).statusCode, 200);
    assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: beforeRelease[1]!.id } })).state, 'BLOCKED');
    assert.equal((await reopen(beforeRelease.map((slot) => slot.id))).statusCode, 200);
    const replay = await put('close', originalBody!, originalKey); assert.equal(replay.statusCode, 200);
    assert.equal((await get()).json().closures.length, 0, 'Historical creation replay cannot reactivate a released closure.');
    const foreign = await put('release', { closureId: originalClosure, expectedUpdatedAt: await revision(b.id) }, randomUUID(), 2); assert.equal(foreign.statusCode, 404);
    await assert.rejects(db.scheduleClosure.update({ where: { id: originalClosure }, data: { releasedAt: null } }));
  });
  await t.test('reserved conflict rolls back closure entirely and preserves the existing confirmed appointment', async () => {
    assert.equal((await put('hours', await window(660, 720))).statusCode, 200);
    const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers, payload: { businessSlug: a.slug } });
    const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
    const slot = await db.availabilitySlot.findFirstOrThrow({ where: { businessId: a.id, startAt: new Date('2030-01-08T01:00Z') } });
    const proposal = await app.inject({ method: 'POST', url: '/api/v1/customer/booking-proposals', headers: { ...headers, cookie, 'idempotency-key': randomUUID() }, payload: { slotId: slot.id, serviceId: service.id, durationMinutes: 60 } }); assert.equal(proposal.statusCode, 201);
    const booking = await app.inject({ method: 'POST', url: '/api/v1/customer/bookings', headers: { ...headers, cookie, 'idempotency-key': randomUUID() }, payload: { proposalId: proposal.json().id, customer: { name: 'Synthetic', email: 'demo@example.test' } } }); assert.equal(booking.statusCode, 201);
    const before = await revision(); const blocked = await put('close', await window(630, 720, null));
    assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'SLOT_RESERVED'); assert.equal(await revision(), before);
    assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.json().id, releasedAt: null } }), 2);
    await assert.rejects(db.scheduleClosure.create({ data: { businessId: a.id, staffId: null, startAt: slot.startAt, endAt: new Date(+slot.startAt + 3600000) } }));
  });
  await t.test('audit failures roll back newly created inventory and action keys; duplicates and stale revisions conflict', async () => {
    const body = { ...(await window(540, 600, staff[0]!.id, '2030-01-09')), staffId: staff[0]!.id }; const key = randomUUID();
    const badRequest = { cookies: { flowpilot_session: cookies[0]!.split('=')[1] }, id: undefined } as unknown as FastifyRequest;
    const count = await db.availabilitySlot.count({ where: { businessId: a.id } }); const before = await revision();
    await assert.rejects(changeSchedulePolicy(db, badRequest, { kind: 'hours', body }, key, clock));
    assert.equal(await revision(), before); assert.equal(await db.availabilitySlot.count({ where: { businessId: a.id } }), count);
    assert.equal((await put('hours', body, key)).statusCode, 200);
    assert.equal((await put('hours', { ...body, endMinute: 630 }, key)).json().code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await put('hours', body)).json().code, 'SCHEDULE_CHANGED');
    const closed = await put('close', await window(780, 840, null)); assert.equal(closed.statusCode, 200);
    assert.equal((await put('close', await window(780, 840, null))).json().code, 'CLOSURE_EXISTS');
  });
  await t.test('concurrent closure/generation use one revision winner; a refreshed generation respects the rule', async () => {
    const body = await window(840, 900, staff[0]!.id, '2030-01-10');
    const results = await Promise.all([put('hours', body), put('close', body, randomUUID(), 0, other)]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
    if (results[1]!.statusCode !== 200) assert.equal((await put('close', await window(840, 900, staff[0]!.id, '2030-01-10'))).statusCode, 200);
    assert.equal((await put('hours', await window(840, 900, staff[0]!.id, '2030-01-10'))).statusCode, 200);
    assert.equal(await db.availabilitySlot.count({ where: { businessId: a.id, startAt: { gte: new Date('2030-01-10T04:00Z'), lt: new Date('2030-01-10T05:00Z') }, state: 'BLOCKED' } }), 2);
  });
  await t.test('database closure trigger rechecks a slot insertion committed while its lock was waiting', async () => {
    let release!: () => void; let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const locked = new Promise<number>((resolve) => { ready = resolve; });
    const startAt = new Date('2030-01-11T00:00Z'); const endAt = new Date(+startAt + 1800000);
    const held = db.$transaction(async (tx) => {
      await tx.availabilitySlot.create({ data: { businessId: a.id, staffId: staff[0]!.id, startAt, endAt } });
      const [row] = await tx.$queryRaw<{ pid: number }[]>(Prisma.sql`SELECT pg_backend_pid() AS pid`); ready(row!.pid); await gate;
    }, { timeout: 10000 });
    const pid = await locked;
    const rejected = assert.rejects(db.scheduleClosure.create({ data: { businessId: a.id, startAt, endAt } }));
    try { let waiting = false;
      for (let n = 0; n < 100; n++) { const [row] = await db.$queryRaw<{ waiting: boolean }[]>(Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`); if (row!.waiting) { waiting = true; break; } await delay(10); }
      assert.equal(waiting, true);
    } finally { release(); await held; }
    await rejected;
    assert.equal(await db.scheduleClosure.count({ where: { businessId: a.id, startAt } }), 0);
  });
});
