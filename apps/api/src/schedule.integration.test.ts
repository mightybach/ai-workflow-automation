import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyRequest } from 'fastify';
import { businessDayBounds, createDatabaseClient, hashPassword, Prisma } from '@flowpilot/db';
import { buildApp } from './app.js';
import { updateSchedule } from './schedule-routes.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use the dedicated local flowpilot_test database.');
const endpoint = '/api/v1/admin/schedule';
const headers = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };
test('Phase 5 Step 2A fixed inventory breaks and closures', async (t) => {
  const db = createDatabaseClient(url); const tag = randomUUID();
  let now = new Date('2030-01-07T22:00:00Z'); const clock = () => new Date(now);
  const app = buildApp({ db, clock, demoAuthEnabled: true }); const other = buildApp({ db, clock });
  const businesses = await Promise.all(['a', 'b'].map((name, index) => db.business.create({ data: { slug: `schedule-${tag}-${name}`, name: `Synthetic ${name}`, timezone: index ? 'America/New_York' : 'Australia/Brisbane' } })));
  const a = businesses[0]!; const b = businesses[1]!; const ids = [a.id, b.id];
  const password = 'synthetic-schedule-password'; const passwordHash = await hashPassword(password);
  const users = await Promise.all(['CLIENT', 'ADMIN', 'CLIENT', 'ADMIN'].map((role, index) => db.user.create({ data: { email: `schedule-${tag}-${index}@example.test`, role: role as 'CLIENT' | 'ADMIN', passwordHash } })));
  await db.businessMembership.createMany({ data: [
    { userId: users[0]!.id, businessId: a.id, role: 'OWNER' }, { userId: users[1]!.id, businessId: a.id, role: 'STAFF' },
    { userId: users[2]!.id, businessId: b.id, role: 'OWNER' },
  ] });
  const staff = await Promise.all(businesses.map((business) => db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } })));
  const service = await db.service.create({ data: { businessId: a.id, slug: 'haircut', name: 'Haircut' } });
  t.after(async () => {
    await app.close(); await other.close();
    try { await db.$transaction(async (tx) => {
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
    }); } finally { await db.$disconnect(); }
  });
  const cookies: string[] = [];
  for (const user of users) {
    const result = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: user.email, password } });
    assert.equal(result.statusCode, 200); cookies.push(String(result.headers['set-cookie']).split(';')[0]!);
  }
  const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers, payload: { businessSlug: a.slug } });
  const customerCookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  let ip = 1;
  const put = (body: Record<string, unknown>, key: string = randomUUID(), actor = 0, server = app) => server.inject({ method: 'PUT', url: endpoint,
    remoteAddress: `127.0.2.${ip++}`, headers: { ...headers, cookie: cookies[actor]!, 'idempotency-key': key }, payload: body });
  const get = (date = '2030-01-08', actor = 0, selectedStaff?: string) => app.inject({ method: 'GET', url: endpoint + '?date=' + date + (selectedStaff ? '&staffId=' + selectedStaff : ''), headers: { cookie: cookies[actor]! } });
  const bodyFor = async (slotIds: string[], state = 'BLOCKED') => ({ slotIds, state, expectedUpdatedAt: (await db.business.findUniqueOrThrow({ where: { id: a.id } })).updatedAt.toISOString() });
  const auditCount = () => db.auditEvent.count({ where: { businessId: a.id, eventType: 'BUSINESS_SCHEDULE_UPDATED' } });
  let day = 0;
  async function inventory(count = 6) {
    const base = Date.parse('2030-01-07T23:00:00Z') + day++ * 86400000;
    const slots = [];
    for (let n = 0; n < count; n++) slots.push(await db.availabilitySlot.create({ data: { businessId: a.id, staffId: staff[0]!.id, startAt: new Date(base + n * 1800000), endAt: new Date(base + (n + 1) * 1800000) } }));
    return slots;
  }
  const propose = (slotId: string, durationMinutes = 60) => app.inject({ method: 'POST', url: '/api/v1/customer/booking-proposals', headers: { ...headers, cookie: customerCookie, 'idempotency-key': randomUUID() }, payload: { slotId, serviceId: service.id, durationMinutes } });
  const confirm = (proposalId: string) => other.inject({ method: 'POST', url: '/api/v1/customer/bookings', headers: { ...headers, cookie: customerCookie, 'idempotency-key': randomUUID() }, payload: { proposalId, customer: { name: 'Synthetic Customer', email: 'demo@example.test' } } });
  const slots = await inventory();
  const foreign = await db.availabilitySlot.create({ data: { businessId: b.id, staffId: staff[1]!.id, startAt: new Date('2030-01-08T15:00:00Z'), endAt: new Date('2030-01-08T15:30:00Z') } });

  await t.test('active scoped reads and OWNER-only edits never inherit global legacy roles', async () => {
    assert.equal((await app.inject({ method: 'GET', url: endpoint + '?date=2030-01-08' })).statusCode, 401);
    assert.equal((await get('2030-01-08', 3)).statusCode, 403);
    const read = await get(); assert.equal(read.statusCode, 200);
    assert.equal(read.json().items.length, 6); assert.equal(read.json().timezone, 'Australia/Brisbane');
    assert.equal(read.json().items[0].staffName, 'Alex');
    assert.equal((await get('2030-01-08', 1)).json().businessId, a.id);
    assert.equal((await put(await bodyFor([slots[0]!.id]), randomUUID(), 1)).statusCode, 403);
    assert.equal((await get('2030-01-08', 0, staff[1]!.id)).statusCode, 404);
    const before = await auditCount();
    assert.equal((await put(await bodyFor([slots[0]!.id, foreign.id]))).statusCode, 404);
    assert.equal(await auditCount(), before); assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slots[0]!.id } })).state, 'AVAILABLE');
  });
  await t.test('invalid scope/state/duplicates/revision/keys and origin overrides are rejected', async () => {
    const body = await bodyFor([slots[0]!.id]);
    for (const patch of [{ slotIds: [] }, { slotIds: [slots[0]!.id, slots[0]!.id.toUpperCase()] }, { state: 'RESERVED' }, { businessId: b.id }, { role: 'OWNER' }, { expectedUpdatedAt: undefined }]) assert.equal((await put({ ...body, ...patch })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: endpoint, headers: { ...headers, cookie: cookies[0]! }, payload: body })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: endpoint, headers: { cookie: cookies[0]! }, payload: body })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: endpoint + '?date=2030-01-08&businessId=' + b.id, headers: { cookie: cookies[0]! } })).statusCode, 400);
  });
  await t.test('blocking a break removes complete-duration starts and prevents stale-proposal confirmation', async () => {
    const proposal = await propose(slots[0]!.id); assert.equal(proposal.statusCode, 201);
    const before = await auditCount(); const body = await bodyFor([slots[1]!.id]);
    const saved = await put(body); assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().changedCount, 1);
    assert.equal(await auditCount(), before + 1);
    const stale = await confirm(proposal.json().id); assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'SLOT_UNAVAILABLE');
    const availability = await app.inject({ method: 'GET', url: `/api/v1/customer/availability?date=2030-01-08&durationMinutes=60&serviceId=${service.id}`, headers: { cookie: customerCookie } });
    assert.equal(availability.statusCode, 200); assert.equal(availability.json().pagination.total, 3);
    const reopen = await put(await bodyFor([slots[1]!.id], 'AVAILABLE')); assert.equal(reopen.statusCode, 200);
    const starts = await app.inject({ method: 'GET', url: `/api/v1/customer/availability?date=2030-01-08&durationMinutes=60&serviceId=${service.id}`, headers: { cookie: customerCookie } });
    assert.equal(starts.json().pagination.total, 5);
  });
  await t.test('exact retry replays history, reordered IDs normalize, stale revisions and changed keys conflict', async () => {
    const key = randomUUID(); const body = await bodyFor([slots[0]!.id, slots[1]!.id]); const before = await auditCount();
    const first = await put(body, key); assert.equal(first.statusCode, 200);
    const replay = await put({ ...body, slotIds: [...body.slotIds].reverse() }, key, 0, other);
    assert.deepEqual(replay.json(), first.json()); assert.equal(replay.headers['idempotency-replayed'], 'true'); assert.equal(await auditCount(), before + 1);
    assert.equal((await put({ ...body, state: 'AVAILABLE' }, key)).json().code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await put(body)).json().code, 'SCHEDULE_CHANGED');
    assert.equal((await put(await bodyFor(body.slotIds, 'AVAILABLE'))).statusCode, 200);
    assert.deepEqual((await put(body, key)).json(), first.json());
    assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slots[0]!.id } })).state, 'AVAILABLE', 'Historical retry cannot restore an old closure.');
  });
  await t.test('concurrent duplicate edits converge; competing revisions and audit failure cannot partially apply', async () => {
    const selected = await inventory(); const body = await bodyFor([selected[0]!.id, selected[1]!.id]); const key = randomUUID(); const before = await auditCount();
    const same = await Promise.all([put(body, key), put(body, key, 0, other)]);
    assert.deepEqual(same.map((result) => result.statusCode), [200, 200]); assert.deepEqual(same[0]!.json(), same[1]!.json()); assert.equal(await auditCount(), before + 1);
    const revision = (await bodyFor([])).expectedUpdatedAt;
    const competing = await Promise.all([put({ slotIds: [selected[2]!.id], state: 'BLOCKED', expectedUpdatedAt: revision }), put({ slotIds: [selected[3]!.id], state: 'BLOCKED', expectedUpdatedAt: revision }, randomUUID(), 0, other)]);
    assert.deepEqual(competing.map((result) => result.statusCode).sort(), [200, 409]);
    const rollbackBody = await bodyFor([selected[4]!.id]); const rollbackKey = randomUUID(); const audits = await auditCount();
    const badRequest = { cookies: { flowpilot_session: cookies[0]!.split('=')[1] }, id: undefined } as unknown as FastifyRequest;
    await assert.rejects(updateSchedule(db, badRequest, { ...rollbackBody, state: 'BLOCKED' }, rollbackKey, clock));
    assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: selected[4]!.id } })).state, 'AVAILABLE'); assert.equal(await auditCount(), audits);
    assert.equal((await put(rollbackBody, rollbackKey)).statusCode, 200);
  });
  await t.test('reserved slots reject the whole batch; bookings/history stay unchanged', async () => {
    const selected = await inventory(); const proposal = await propose(selected[0]!.id); const booking = await confirm(proposal.json().id); assert.equal(booking.statusCode, 201);
    const before = await auditCount(); const blocked = await put(await bodyFor([selected[1]!.id, selected[2]!.id]));
    assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'SLOT_RESERVED');
    assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: selected[2]!.id } })).state, 'AVAILABLE');
    assert.equal(await auditCount(), before); assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.json().id, releasedAt: null } }), 2);
    assert.equal((await put(await bodyFor([selected[0]!.id], 'AVAILABLE'))).json().code, 'SLOT_RESERVED');
  });
  await t.test('a closure racing confirmation has one winner and never leaves a partial appointment/edit', async () => {
    const selected = await inventory(); const proposal = await propose(selected[0]!.id); assert.equal(proposal.statusCode, 201);
    const body = await bodyFor([selected[1]!.id, selected[2]!.id]);
    const [block, booking] = await Promise.all([put(body), confirm(proposal.json().id)]);
    assert.equal((block.statusCode === 200 ? 1 : 0) + (booking.statusCode === 201 ? 1 : 0), 1);
    const states = await db.availabilitySlot.findMany({ where: { id: { in: selected.slice(0, 3).map((slot) => slot.id) } }, orderBy: { startAt: 'asc' } });
    assert.deepEqual(states.map((slot) => slot.state), block.statusCode === 200 ? ['AVAILABLE', 'BLOCKED', 'BLOCKED'] : ['RESERVED', 'RESERVED', 'AVAILABLE']);
  });
  await t.test('inactive staff cannot reopen; past slots and same-state no-ops obey future/retry rules', async () => {
    const selected = await inventory(); assert.equal((await put(await bodyFor([selected[0]!.id]))).statusCode, 200);
    await db.staff.update({ where: { id: staff[0]!.id }, data: { active: false } });
    assert.equal((await put(await bodyFor([selected[0]!.id], 'AVAILABLE'))).json().code, 'STAFF_UNAVAILABLE');
    await db.staff.update({ where: { id: staff[0]!.id }, data: { active: true } });
    const body = await bodyFor([selected[0]!.id]); const key = randomUUID();
    const noop = await put(body, key); assert.equal(noop.json().changedCount, 0); assert.equal(noop.json().updatedAt, body.expectedUpdatedAt);
    const savedNow = now; now = new Date(+selected[1]!.startAt);
    assert.equal((await put(await bodyFor([selected[1]!.id]))).json().code, 'PAST_SLOT');
    assert.deepEqual((await put(body, key)).json(), noop.json()); now = savedNow;
  });
  await t.test('future check is repeated after waiting for booking/business locks', async () => {
    const selected = await inventory(); const body = await bodyFor([selected[0]!.id]);
    let release!: () => void; let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const locked = new Promise<number>((resolve) => { ready = resolve; });
    const held = db.$transaction(async (tx) => { await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${a.id}::uuid FOR SHARE`);
      const [row] = await tx.$queryRaw<{ pid: number }[]>(Prisma.sql`SELECT pg_backend_pid() AS pid`); ready(row!.pid); await gate; }, { timeout: 10000 });
    const pid = await locked; const pending = Promise.resolve(put(body)); const savedNow = now;
    try {
      let waiting = false;
      for (let n = 0; n < 100; n++) { const [row] = await db.$queryRaw<{ waiting: boolean }[]>(Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`);
        if (row!.waiting) { waiting = true; break; } await delay(10); }
      assert.equal(waiting, true); now = new Date(+selected[0]!.startAt);
    } finally { release(); await held; }
    try { assert.equal((await pending).json().code, 'PAST_SLOT'); } finally { now = savedNow; }
    assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: selected[0]!.id } })).state, 'AVAILABLE');
  });
  await t.test('business-local DST dates return the real 23-hour inventory day', async () => {
    const bounds = businessDayBounds('2030-03-10', 'America/New_York');
    const data = [];
    for (let start = +bounds.start; start <= +bounds.end; start += 1800000) data.push({ businessId: b.id, staffId: staff[1]!.id, startAt: new Date(start), endAt: new Date(start + 1800000) });
    await db.availabilitySlot.createMany({ data });
    const read = await get('2030-03-10', 2); assert.equal(read.statusCode, 200); assert.equal(read.json().items.length, 46); assert.equal(read.json().timezone, 'America/New_York');
  });
});
