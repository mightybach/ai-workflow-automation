import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { createDatabaseClient, hashPassword, Prisma } from '@flowpilot/db';
import { buildApp } from './app.js';
import { cancelBooking } from './booking-cancellation.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use dedicated local flowpilot_test.');
const headers = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };
const customer = { name: 'Synthetic', email: 'demo@example.test' };

test('Phase 5 Step 3 explicit owned cancellation and complete historical releases', async (t) => {
  const db = createDatabaseClient(url); const tag = randomUUID(); let now = new Date('2030-01-07T22:00Z'); const clock = () => new Date(now);
  const app = buildApp({ db, clock, demoAuthEnabled: true }); const other = buildApp({ db, clock });
  const businesses = await Promise.all(['a', 'b'].map((suffix) => db.business.create({ data: { slug: `cancel-${tag}-${suffix}`, name: 'Synthetic Cancellation' } })));
  const a = businesses[0]!; const ids = businesses.map((business) => business.id);
  const staff = await Promise.all(businesses.map((business) => db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } })));
  const services = await Promise.all(businesses.map((business) => db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } })));
  const password = 'synthetic-cancel-password';
  const owner = await db.user.create({ data: { email: `cancel-${tag}@example.test`, role: 'CLIENT', passwordHash: await hashPassword(password) } });
  await db.businessMembership.create({ data: { businessId: a.id, userId: owner.id, role: 'OWNER' } });
  t.after(async () => {
    await app.close(); await other.close();
    try { await db.$transaction(async (tx) => {
      await tx.auditEvent.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingAction.deleteMany({ where: { businessId: { in: ids } } });
      await tx.bookingSlot.deleteMany({ where: { businessId: { in: ids } } }); await tx.booking.deleteMany({ where: { businessId: { in: ids } } });
      await tx.bookingProposal.deleteMany({ where: { businessId: { in: ids } } }); await tx.customerSession.deleteMany({ where: { businessId: { in: ids } } });
      await tx.scheduleClosure.deleteMany({ where: { businessId: { in: ids } } }); await tx.availabilitySlot.deleteMany({ where: { businessId: { in: ids } } });
      await tx.service.deleteMany({ where: { businessId: { in: ids } } }); await tx.staff.deleteMany({ where: { businessId: { in: ids } } });
      await tx.businessMembership.deleteMany({ where: { businessId: { in: ids } } }); await tx.business.deleteMany({ where: { id: { in: ids } } }); await tx.user.delete({ where: { id: owner.id } });
    }); } finally { await db.$disconnect(); }
  });
  const cookies: string[] = [];
  for (const index of [0, 0, 1]) { const response = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers, payload: { businessSlug: businesses[index]!.slug } }); assert.equal(response.statusCode, 201); cookies.push(String(response.headers['set-cookie']).split(';')[0]!); }
  // Keep synthetic identities live while testing starts on several future days.
  await db.customerSession.updateMany({ where: { businessId: { in: ids } }, data: { expiresAt: new Date('2031-01-01T00:00Z') } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: owner.email, password } }); const ownerCookie = String(login.headers['set-cookie']).split(';')[0]!;
  let ip = 1; let day = 0;
  const post = (path: string, payload: object, cookie = cookies[0]!, key = randomUUID(), server = app) => server.inject({ method: 'POST', url: '/api/v1/customer/' + path, remoteAddress: `127.0.7.${ip++}`, headers: { ...headers, cookie, 'idempotency-key': key }, payload });
  const cancel = (id: string, key = randomUUID(), cookie = cookies[0]!, server = app) => post(`bookings/${id}/cancel`, {}, cookie, key, server);
  const read = (id: string, cookie = cookies[0]!) => app.inject({ method: 'GET', url: '/api/v1/customer/bookings/' + id, headers: { cookie } });
  const inventory = async () => {
    const start = Date.parse('2030-01-07T23:00Z') + day++ * 86400000;
    const slots = [];
    for (let n = 0; n < 4; n++) slots.push(await db.availabilitySlot.create({ data: { businessId: a.id, staffId: staff[0]!.id, startAt: new Date(start + n * 1800000), endAt: new Date(start + (n + 1) * 1800000) } }));
    return slots;
  };
  const propose = async (slots: Awaited<ReturnType<typeof inventory>>, cookie = cookies[0]!, duration = 120) => {
    const result = await post('booking-proposals', { slotId: slots[0]!.id, serviceId: services[0]!.id, durationMinutes: duration }, cookie); assert.equal(result.statusCode, 201, result.body); return result.json() as { id: string };
  };
  const book = async (slots: Awaited<ReturnType<typeof inventory>>, cookie = cookies[0]!, duration = 120) => {
    const proposal = await propose(slots, cookie, duration); const key = randomUUID(); const body = { proposalId: proposal.id, customer };
    const result = await post('bookings', body, cookie, key); assert.equal(result.statusCode, 201, result.body);
    return { booking: result.json() as { id: string; reference: string; startAt: string }, confirmKey: key, confirmBody: body };
  };
  let firstId = ''; const firstKey = randomUUID();
  await t.test('strict explicit request, origin, session and two-business/customer ownership boundaries', async () => {
    const { booking } = await book(await inventory()); firstId = booking.id;
    for (const cookie of [cookies[1]!, cookies[2]!]) assert.equal((await cancel(firstId, randomUUID(), cookie)).statusCode, 404);
    assert.equal((await cancel(firstId, randomUUID(), ownerCookie)).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/customer/bookings/${firstId}/cancel`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: {} })).statusCode, 401);
    for (const payload of [{ confirmed: true }, { status: 'CANCELLED' }, { businessId: a.id }, { bookingId: firstId }, { reason: 'raw text' }]) assert.equal((await post(`bookings/${firstId}/cancel`, payload)).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/customer/bookings/${firstId}/cancel`, headers: { ...headers, cookie: cookies[0]! }, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/customer/bookings/${firstId}/cancel`, headers: { cookie: cookies[0]!, 'idempotency-key': randomUUID() }, payload: {} })).statusCode, 403);
    assert.equal((await post(`bookings/${firstId}/cancel?businessId=${a.id}`, {})).statusCode, 400);
    assert.equal((await read(firstId)).json().status, 'CONFIRMED');
  });
  await t.test('one transaction cancels all four slots, preserves links/reference, and records one minimal audit', async () => {
    const before = await db.business.findUniqueOrThrow({ where: { id: a.id } });
    const response = await cancel(firstId, firstKey); assert.equal(response.statusCode, 200, response.body);
    const result = response.json(); assert.equal(result.status, 'CANCELLED'); assert.equal(result.cancelledAt, now.toISOString());
    assert.equal(await db.bookingSlot.count({ where: { bookingId: firstId } }), 4); assert.equal(await db.bookingSlot.count({ where: { bookingId: firstId, releasedAt: null } }), 0);
    const links = await db.bookingSlot.findMany({ where: { bookingId: firstId }, include: { slot: true } }); assert.ok(links.every((link) => link.slot.state === 'AVAILABLE' && +link.releasedAt! === +now));
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: firstId, eventType: 'BOOKING_CANCELLED' } }); assert.deepEqual(audit.metadata, { durationMinutes: 120 }); assert.equal(audit.actorType, 'SYSTEM'); assert.equal(audit.traceId, response.headers['x-trace-id']);
    assert.ok(+(await db.business.findUniqueOrThrow({ where: { id: a.id } })).updatedAt > +before.updatedAt);
    assert.deepEqual((await read(firstId)).json(), result);
  });
  await t.test('parallel retries and different keys converge, old confirmation replay cannot revive a booking or release a rebooking', async () => {
    const slots = await inventory(); const first = await book(slots); const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 4 }, (_, n) => cancel(first.booking.id, key, cookies[0]!, n % 2 ? other : app)));
    assert.ok(responses.every((response) => response.statusCode === 200)); assert.equal(new Set(responses.map((response) => response.body)).size, 1);
    const again = await cancel(first.booking.id); assert.deepEqual(again.json(), responses[0]!.json());
    assert.equal(await db.auditEvent.count({ where: { entityId: first.booking.id, eventType: 'BOOKING_CANCELLED' } }), 1);
    const replacement = await book(slots, cookies[1]!);
    assert.equal((await cancel(first.booking.id, key)).statusCode, 200); assert.equal((await cancel(first.booking.id)).statusCode, 200);
    assert.equal(await db.bookingSlot.count({ where: { bookingId: replacement.booking.id, releasedAt: null } }), 4);
    const old = await post('bookings', first.confirmBody, cookies[0]!, first.confirmKey); assert.equal(old.json().status, 'CONFIRMED', 'Creation replay remains immutable.');
    assert.equal((await read(first.booking.id)).json().status, 'CANCELLED');
    assert.equal((await cancel(replacement.booking.id, key)).json().code, 'IDEMPOTENCY_CONFLICT');
  });
  await t.test('audit failure rolls back state, release, revision and action key', async () => {
    const { booking } = await book(await inventory()); const key = randomUUID(); const revision = (await db.business.findUniqueOrThrow({ where: { id: a.id } })).updatedAt;
    const bad = { cookies: { flowpilot_customer_session: cookies[0]!.split('=')[1] }, id: undefined } as unknown as FastifyRequest;
    await assert.rejects(cancelBooking(db, bad, booking.id, key, clock));
    assert.equal((await read(booking.id)).json().status, 'CONFIRMED'); assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id, releasedAt: null } }), 4);
    assert.equal(+(await db.business.findUniqueOrThrow({ where: { id: a.id } })).updatedAt, +revision);
    assert.equal(await db.bookingAction.count({ where: { bookingId: booking.id, operation: 'CANCEL' } }), 0);
    assert.equal((await cancel(booking.id, key)).statusCode, 200);
  });
  await t.test('inactive staff release remains blocked; inactive service and reduced maximum do not trap the customer', async () => {
    const { booking } = await book(await inventory());
    await db.staff.update({ where: { id: staff[0]!.id }, data: { active: false } }); await db.service.update({ where: { id: services[0]!.id }, data: { active: false } }); await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 30 } });
    try { assert.equal((await cancel(booking.id)).statusCode, 200); const links = await db.bookingSlot.findMany({ where: { bookingId: booking.id }, include: { slot: true } }); assert.ok(links.every((link) => link.slot.state === 'BLOCKED')); }
    finally { await db.staff.update({ where: { id: staff[0]!.id }, data: { active: true } }); await db.service.update({ where: { id: services[0]!.id }, data: { active: true } }); await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 120 } }); }
  });
  await t.test('started appointments reject new cancellation; original replay and cancelled no-ops remain safe', async () => {
    const { booking } = await book(await inventory()); const prior = now; now = new Date(booking.startAt);
    try { assert.equal((await cancel(booking.id)).json().code, 'CANCELLATION_TOO_LATE'); assert.equal((await cancel(firstId, firstKey)).statusCode, 200); assert.equal((await cancel(firstId)).statusCode, 200); }
    finally { now = prior; }
    assert.equal((await read(booking.id)).json().status, 'CONFIRMED');
  });
  await t.test('cancellation racing closure or a competing confirmation has no partial release or reopened closure', async () => {
    const slots = await inventory(); const competing = await propose(slots, cookies[1]!); const { booking } = await book(slots);
    const expectedUpdatedAt = (await db.business.findUniqueOrThrow({ where: { id: a.id } })).updatedAt.toISOString();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit' }).format(slots[0]!.startAt);
    const close = () => app.inject({ method: 'PUT', url: '/api/v1/admin/schedule/close', headers: { ...headers, cookie: ownerCookie, 'idempotency-key': randomUUID() }, payload: { date, staffId: null, startMinute: 540, endMinute: 660, expectedUpdatedAt } });
    const results = await Promise.all([cancel(booking.id), close(), post('bookings', { proposalId: competing.id, customer }, cookies[1]!)]);
    assert.equal(results[0]!.statusCode, 200); assert.equal(results[1]!.statusCode, 409);
    if (results[2]!.statusCode === 201) assert.equal(await db.bookingSlot.count({ where: { bookingId: results[2]!.json().id, releasedAt: null } }), 4);
    else { assert.equal(results[2]!.statusCode, 409); const revision = (await db.business.findUniqueOrThrow({ where: { id: a.id } })).updatedAt.toISOString();
      const closed = await app.inject({ method: 'PUT', url: '/api/v1/admin/schedule/close', headers: { ...headers, cookie: ownerCookie, 'idempotency-key': randomUUID() }, payload: { date, staffId: null, startMinute: 540, endMinute: 660, expectedUpdatedAt: revision } }); assert.equal(closed.statusCode, 200, closed.body);
      assert.equal((await cancel(booking.id)).statusCode, 200); assert.equal(await db.availabilitySlot.count({ where: { id: { in: slots.map((slot) => slot.id) }, state: 'BLOCKED' } }), 4);
    }
  });
  await t.test('future-time check is repeated after waiting for the business lock', async () => {
    const { booking } = await book(await inventory()); const prior = now; let release!: () => void; let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const locked = new Promise<number>((resolve) => { ready = resolve; });
    const held = db.$transaction(async (tx) => { await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${a.id}::uuid FOR UPDATE`); const [row] = await tx.$queryRaw<{ pid: number }[]>(Prisma.sql`SELECT pg_backend_pid() AS pid`); ready(row!.pid); await gate; }, { timeout: 10000 });
    const pid = await locked; const pending = cancel(booking.id);
    try { let waiting = false; for (let n = 0; n < 100; n++) { const [row] = await db.$queryRaw<{ waiting: boolean }[]>(Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`); if (row!.waiting) { waiting = true; break; } await delay(10); } assert.equal(waiting, true); now = new Date(booking.startAt); }
    finally { release(); await held; }
    try { assert.equal((await pending).json().code, 'CANCELLATION_TOO_LATE'); } finally { now = prior; }
  });
  await t.test('a closure added after release is preserved by old and new cancellation keys', async () => {
    const slots = await inventory(); const { booking } = await book(slots); const key = randomUUID();
    assert.equal((await cancel(booking.id, key)).statusCode, 200);
    const expectedUpdatedAt = (await db.business.findUniqueOrThrow({ where: { id: a.id } })).updatedAt.toISOString();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit' }).format(slots[0]!.startAt);
    const closed = await app.inject({ method: 'PUT', url: '/api/v1/admin/schedule/close', headers: { ...headers, cookie: ownerCookie, 'idempotency-key': randomUUID() }, payload: { date, staffId: null, startMinute: 540, endMinute: 660, expectedUpdatedAt } });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal((await cancel(booking.id, key)).statusCode, 200); assert.equal((await cancel(booking.id)).statusCode, 200);
    assert.equal(await db.availabilitySlot.count({ where: { id: { in: slots.map((slot) => slot.id) }, state: 'BLOCKED' } }), 4);
  });
  await t.test('HTTP restart replays the durable cancellation while revoked identity cannot replay', async () => {
    const { booking } = await book(await inventory()); const key = randomUUID();
    const server = buildApp({ db, clock }); const address = await server.listen({ host: '127.0.0.1', port: 0 });
    let body: unknown;
    try { const response = await fetch(address + `/api/v1/customer/bookings/${booking.id}/cancel`, { method: 'POST', headers: { ...headers, cookie: cookies[0]!, 'idempotency-key': key, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 200); body = await response.json();
    } finally { await server.close(); }
    const restart = buildApp({ db, clock });
    try { assert.deepEqual((await cancel(booking.id, key, cookies[0]!, restart)).json(), body); } finally { await restart.close(); }
    const revoked = await app.inject({ method: 'POST', url: '/api/v1/customer/logout', headers: { ...headers, cookie: cookies[0]! }, payload: {} }); assert.equal(revoked.statusCode, 200);
    assert.equal((await cancel(booking.id, key)).statusCode, 401);
    await db.business.update({ where: { id: a.id }, data: { active: false } });
    assert.equal((await cancel(booking.id, key, cookies[1]!)).statusCode, 401);
    await db.business.update({ where: { id: a.id }, data: { active: true } });
    await db.customerSession.updateMany({ where: { businessId: a.id }, data: { expiresAt: new Date(+now + 1) } });
    now = new Date(+now + 2);
    assert.equal((await cancel(booking.id, key, cookies[1]!)).statusCode, 401);
  });
});
