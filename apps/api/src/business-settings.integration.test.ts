import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { createDatabaseClient, hashPassword, Prisma } from '@flowpilot/db';
import { buildApp } from './app.js';
import { updateBookingSettings } from './business-settings.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use the dedicated local flowpilot_test database.');
const endpoint = '/api/v1/admin/business/booking-settings';
const headers = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };

test('Phase 5 Step 1 scoped owner booking-duration settings', async (t) => {
  const db = createDatabaseClient(url);
  const clock = () => new Date('2030-01-07T22:00:00Z');
  const app = buildApp({ db, demoAuthEnabled: true, clock });
  const second = buildApp({ db, clock });
  const tag = randomUUID();
  const password = 'synthetic-settings-password';
  const passwordHash = await hashPassword(password);
  const businesses = await Promise.all(['a', 'b'].map((name) => db.business.create({ data: { slug: `settings-${tag}-${name}`, name: `Synthetic ${name}` } })));
  const ids = businesses.map((item) => item.id);
  const users = await Promise.all(['CLIENT', 'ADMIN', 'CLIENT', 'ADMIN', 'CLIENT'].map((role, index) => db.user.create({ data: {
    email: `settings-${tag}-${index}@example.test`, role: role as 'CLIENT' | 'ADMIN', passwordHash,
  } })));
  const owner = await db.businessMembership.create({ data: { userId: users[0]!.id, businessId: ids[0]!, role: 'OWNER' } });
  await db.businessMembership.createMany({ data: [
    { userId: users[1]!.id, businessId: ids[0]!, role: 'STAFF' },
    { userId: users[2]!.id, businessId: ids[1]!, role: 'OWNER' },
    { userId: users[4]!.id, businessId: ids[0]!, role: 'OWNER' },
  ] });
  t.after(async () => {
    await app.close(); await second.close();
    try {
      await db.$transaction(async (tx) => {
        await tx.auditEvent.deleteMany({ where: { businessId: { in: ids } } });
        await tx.notificationOutbox.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingAction.deleteMany({ where: { businessId: { in: ids } } });
        await tx.bookingSlot.deleteMany({ where: { businessId: { in: ids } } });
        await tx.booking.deleteMany({ where: { businessId: { in: ids } } });
        await tx.bookingProposal.deleteMany({ where: { businessId: { in: ids } } });
        await tx.customerSession.deleteMany({ where: { businessId: { in: ids } } });
        await tx.availabilitySlot.deleteMany({ where: { businessId: { in: ids } } });
        await tx.service.deleteMany({ where: { businessId: { in: ids } } });
        await tx.staff.deleteMany({ where: { businessId: { in: ids } } });
        await tx.businessMembership.deleteMany({ where: { businessId: { in: ids } } });
        await tx.business.deleteMany({ where: { id: { in: ids } } });
        await tx.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
      });
    } finally { await db.$disconnect(); }
  });
  const cookies: string[] = [];
  for (const user of users) {
    const result = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: user.email, password } });
    assert.equal(result.statusCode, 200);
    cookies.push(String(result.headers['set-cookie']).split(';')[0]!);
  }
  let address = 1;
  const get = (index = 0) => app.inject({ method: 'GET', url: endpoint, headers: { cookie: cookies[index]! } });
  const put = (body: Record<string, unknown>, key = randomUUID(), index = 0, server = app) => server.inject({ method: 'PUT', url: endpoint,
    remoteAddress: `127.0.1.${address++}`, headers: { ...headers, cookie: cookies[index]!, 'idempotency-key': key }, payload: body });
  const settings = async (index = 0) => { const result = await get(index); assert.equal(result.statusCode, 200); return result.json() as { businessId: string; maxBookingDurationMinutes: number; updatedAt: string }; };
  const bodyFor = async (maximum: number, index = 0) => ({ maxBookingDurationMinutes: maximum, expectedUpdatedAt: (await settings(index)).updatedAt });
  const count = () => db.auditEvent.count({ where: { businessId: ids[0]!, eventType: 'BUSINESS_BOOKING_DURATION_UPDATED' } });

  await t.test('OWNER/STAFF read own policy; only OWNER writes, never legacy ADMIN or anonymous customers', async () => {
    assert.equal((await app.inject({ method: 'GET', url: endpoint })).statusCode, 401);
    assert.equal((await get(3)).statusCode, 403);
    assert.equal((await settings(1)).businessId, ids[0]!);
    assert.equal((await settings(2)).businessId, ids[1]);
    assert.equal((await put(await bodyFor(60), randomUUID(), 1)).statusCode, 403);
    assert.equal((await put(await bodyFor(60), randomUUID(), 3)).statusCode, 403);
    assert.equal((await settings()).maxBookingDurationMinutes, 120);
  });
  await t.test('strict input, stable keys, same-origin and business boundaries are enforced', async () => {
    const body = await bodyFor(60);
    for (const maximum of [0, 15, 45, 1470, '60', true, null, 60.5]) assert.equal((await put({ ...body, maxBookingDurationMinutes: maximum })).statusCode, 400);
    for (const extra of [{ businessId: ids[1] }, { role: 'OWNER' }, { actorId: users[0]!.id }, { expectedUpdatedAt: undefined }]) assert.equal((await put({ ...body, ...extra })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: endpoint, headers: { ...headers, cookie: cookies[0]! }, payload: body })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: endpoint, headers: { cookie: cookies[0]! }, payload: body })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: endpoint + '?businessId=' + ids[1], headers: { cookie: cookies[0]! } })).statusCode, 400);
    const foreign = await put(await bodyFor(90, 2), randomUUID(), 2);
    assert.equal(foreign.statusCode, 200);
    assert.equal(foreign.json().businessId, ids[1]);
    assert.equal((await settings()).maxBookingDurationMinutes, 120);
  });
  await t.test('policy and minimal USER audit commit together; stale editors receive a conflict', async () => {
    const before = await settings(); const audits = await count();
    const result = await put({ maxBookingDurationMinutes: 60, expectedUpdatedAt: before.updatedAt });
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(Date.parse(result.json().updatedAt) > Date.parse(before.updatedAt));
    assert.equal(await count(), audits + 1);
    const event = await db.auditEvent.findFirstOrThrow({ where: { businessId: ids[0]!, eventType: 'BUSINESS_BOOKING_DURATION_UPDATED' } });
    assert.equal(event.actorType, 'USER'); assert.equal(event.actorId, users[0]!.id);
    assert.equal(event.entityId, ids[0]!); assert.equal(event.traceId, result.headers['x-trace-id']);
    assert.equal((event.metadata as { previousMaximumMinutes: number }).previousMaximumMinutes, 120);
    assert.equal(JSON.stringify(event.metadata).includes(cookies[0]!.split('=')[1]!), false);
    const stale = await put({ maxBookingDurationMinutes: 90, expectedUpdatedAt: before.updatedAt });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'SETTINGS_CHANGED');
    assert.equal((await settings()).maxBookingDurationMinutes, 60);
  });
  await t.test('retries replay one immutable snapshot and keys are scoped by actor/business', async () => {
    const body = await bodyFor(90); const key = randomUUID();
    const first = await put(body, key); assert.equal(first.statusCode, 200);
    const audits = await count();
    const retry = await put(body, key, 0, second);
    assert.deepEqual(retry.json(), first.json()); assert.equal(retry.headers['idempotency-replayed'], 'true');
    assert.equal(await count(), audits);
    assert.equal((await put({ ...body, maxBookingDurationMinutes: 60 }, key)).json().code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await put(await bodyFor(120))).statusCode, 200);
    assert.deepEqual((await put(body, key)).json(), first.json());
    assert.equal((await settings()).maxBookingDurationMinutes, 120, 'An old retry must not restore its historical value.');
    assert.equal((await put(await bodyFor(30, 4), key, 4)).statusCode, 200);
    assert.equal((await put(await bodyFor(60, 2), key, 2)).statusCode, 200);
  });
  await t.test('concurrent identical writes converge; different keys on the same revision have one winner', async () => {
    const body = await bodyFor(90); const key = randomUUID(); const audits = await count();
    const identical = await Promise.all([put(body, key), put(body, key, 0, second)]);
    assert.deepEqual(identical.map((result) => result.statusCode), [200, 200]);
    assert.deepEqual(identical[0]!.json(), identical[1]!.json()); assert.equal(await count(), audits + 1);
    const revision = (await settings()).updatedAt;
    const competing = await Promise.all([put({ maxBookingDurationMinutes: 60, expectedUpdatedAt: revision }), put({ maxBookingDurationMinutes: 120, expectedUpdatedAt: revision }, randomUUID(), 0, second)]);
    assert.deepEqual(competing.map((result) => result.statusCode).sort(), [200, 409]);
    const unchanged = await settings(); const sameKey = randomUUID(); const noOpBody = { maxBookingDurationMinutes: unchanged.maxBookingDurationMinutes, expectedUpdatedAt: unchanged.updatedAt };
    const noOp = await put(noOpBody, sameKey); assert.equal(noOp.json().updatedAt, unchanged.updatedAt);
    const auditCount = await count(); await put(noOpBody, sameKey); assert.equal(await count(), auditCount);
  });
  await t.test('audit failure rolls back policy/revision and does not consume the action key', async () => {
    const before = await settings(); const audits = await count(); const key = randomUUID();
    const body = { maxBookingDurationMinutes: before.maxBookingDurationMinutes === 30 ? 60 : 30, expectedUpdatedAt: before.updatedAt };
    const badRequest = { cookies: { flowpilot_session: cookies[0]!.split('=')[1] }, id: undefined } as unknown as FastifyRequest;
    await assert.rejects(updateBookingSettings(db, badRequest, body, key, clock));
    assert.deepEqual(await settings(), before); assert.equal(await count(), audits);
    assert.equal((await put(body, key)).statusCode, 200);
  });
  await t.test('reduced maximum rejects older proposals and new availability but preserves confirmed appointments', async () => {
    assert.equal((await put(await bodyFor(120))).statusCode, 200);
    const staff = await db.staff.create({ data: { businessId: ids[0]!, slug: 'alex', displayName: 'Alex' } });
    const service = await db.service.create({ data: { businessId: ids[0]!, slug: 'haircut', name: 'Haircut' } });
    const slots: { id: string }[] = [];
    for (let slot = 0; slot < 8; slot++) slots.push(await db.availabilitySlot.create({ data: { businessId: ids[0]!, staffId: staff.id,
      startAt: new Date(Date.parse('2030-01-07T23:00:00Z') + slot * 1800000), endAt: new Date(Date.parse('2030-01-07T23:30:00Z') + slot * 1800000) } }));
    const session = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers, payload: { businessSlug: businesses[0]!.slug } });
    const cookie = String(session.headers['set-cookie']).split(';')[0]!;
    const propose = (index: number) => app.inject({ method: 'POST', url: '/api/v1/customer/booking-proposals', headers: { ...headers, cookie, 'idempotency-key': randomUUID() }, payload: { slotId: slots[index]!.id, serviceId: service.id, durationMinutes: 120 } });
    const first = await propose(0); const older = await propose(4);
    assert.equal(first.statusCode, 201); assert.equal(older.statusCode, 201);
    const confirm = (proposalId: string) => app.inject({ method: 'POST', url: '/api/v1/customer/bookings', headers: { ...headers, cookie, 'idempotency-key': randomUUID() }, payload: { proposalId, customer: { name: 'Synthetic Customer', email: 'demo@example.test' } } });
    const booked = await confirm(first.json().id); assert.equal(booked.statusCode, 201);
    assert.equal((await put(await bodyFor(60))).statusCode, 200);
    const blocked = await confirm(older.json().id); assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'DURATION_NOT_ALLOWED');
    const availability = await app.inject({ method: 'GET', url: `/api/v1/customer/availability?date=2030-01-08&serviceId=${service.id}&durationMinutes=120`, headers: { cookie } });
    assert.equal(availability.json().code, 'DURATION_NOT_ALLOWED');
    const currentSession = await app.inject({ method: 'GET', url: '/api/v1/customer/session', headers: { cookie } });
    assert.equal(currentSession.json().maxBookingDurationMinutes, 60);
    const owned = await app.inject({ method: 'GET', url: '/api/v1/customer/bookings/' + booked.json().id, headers: { cookie } });
    assert.equal(owned.json().durationMinutes, 120);
    assert.equal(await db.bookingSlot.count({ where: { bookingId: booked.json().id, releasedAt: null } }), 4);
    assert.equal(await db.booking.count({ where: { businessId: ids[0]! } }), 1);
  });

  async function whileBusinessLocked(action: () => ReturnType<typeof put>, change: () => Promise<unknown>, shared = false) {
    let release!: () => void; let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<number>((resolve) => { ready = resolve; });
    const held = db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${ids[0]!}::uuid ${shared ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`}`);
      const [row] = await tx.$queryRaw<{ pid: number }[]>(Prisma.sql`SELECT pg_backend_pid() AS pid`);
      ready(row!.pid); await gate;
    }, { timeout: 10000 });
    const pid = await locked;
    const pending = Promise.resolve(action());
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await db.$queryRaw<{ waiting: boolean }[]>(Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`);
        if (row!.waiting) { waiting = true; break; }
        await delay(10);
      }
      assert.equal(waiting, true, 'The API must be waiting on the business row before access changes.');
      await change();
    } finally { release(); await held; }
    return pending;
  }
  await t.test('policy writes serialize with booking readers using the shared business lock', async () => {
    const body = await bodyFor(90);
    const result = await whileBusinessLocked(() => put(body), async () => {}, true);
    assert.equal(result.statusCode, 200);
  });
  await t.test('ownership is rechecked after waiting; replay never bypasses inactive membership/business', async () => {
    const body = await bodyFor(120);
    const denied = await whileBusinessLocked(() => put(body), () => db.businessMembership.update({ where: { id: owner.id }, data: { role: 'STAFF' } }));
    assert.equal(denied.statusCode, 403);
    await db.businessMembership.update({ where: { id: owner.id }, data: { role: 'OWNER' } });
    const key = randomUUID(); const good = await put(await bodyFor(120), key); assert.equal(good.statusCode, 200);
    await db.businessMembership.update({ where: { id: owner.id }, data: { active: false } });
    assert.equal((await put(body, key)).statusCode, 403);
    await db.businessMembership.update({ where: { id: owner.id }, data: { active: true } });
    await db.business.update({ where: { id: ids[0]! }, data: { active: false } });
    assert.equal((await get()).statusCode, 403);
    await db.business.update({ where: { id: ids[0]! }, data: { active: true } });
  });
  await t.test('logout while a policy write waits prevents the effect', async () => {
    const body = await bodyFor(60); const audits = await count();
    const denied = await whileBusinessLocked(() => put(body), () => db.session.deleteMany({ where: { userId: users[0]!.id } }));
    assert.equal(denied.statusCode, 401); assert.equal(await count(), audits);
  });
});
