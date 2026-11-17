import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { createDatabaseClient } from '@flowpilot/db';
import { BookingResponseSchema } from '@flowpilot/contracts';
import { buildApp } from './app.js';
import { confirmBooking } from './booking-service.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use the dedicated local flowpilot_test database.');
const write = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };
const customer = { name: 'Synthetic Customer', email: 'demo@example.test' };

test('Phase 2 atomic explicit booking confirmation and owned reads', async (t) => {
  const db = createDatabaseClient(url);
  let now = new Date('2030-01-07T22:00:00Z');
  const clock = () => new Date(now);
  const app = buildApp({ db, clock });
  const second = buildApp({ db, clock });
  const tag = randomUUID();
  const businesses = await Promise.all(['a', 'b'].map((suffix) => db.business.create({ data: { slug: 'confirm-' + tag + suffix, name: 'Synthetic ' + suffix } })));
  const ids = businesses.map((business) => business.id);
  t.after(async () => {
    await app.close(); await second.close();
    try {
      await db.$transaction(async (tx) => {
        await tx.auditEvent.deleteMany({ where: { businessId: { in: ids } } });
        await tx.bookingAction.deleteMany({ where: { businessId: { in: ids } } });
        await tx.bookingSlot.deleteMany({ where: { businessId: { in: ids } } });
        await tx.booking.deleteMany({ where: { businessId: { in: ids } } });
        await tx.bookingProposal.deleteMany({ where: { businessId: { in: ids } } });
        await tx.customerSession.deleteMany({ where: { businessId: { in: ids } } });
        await tx.availabilitySlot.deleteMany({ where: { businessId: { in: ids } } });
        await tx.service.deleteMany({ where: { businessId: { in: ids } } });
        await tx.staff.deleteMany({ where: { businessId: { in: ids } } });
        await tx.business.deleteMany({ where: { id: { in: ids } } });
      });
    } finally { await db.$disconnect(); }
  });
  const staff = await Promise.all(businesses.map((business) => db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } })));
  const services = await Promise.all(businesses.map((business) => db.service.create({ data: { businessId: business.id, slug: 'consultation', name: 'Consultation' } })));
  const session = async (index = 0) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers: write, payload: { businessSlug: businesses[index]!.slug } });
    assert.equal(response.statusCode, 201);
    return String(response.headers['set-cookie']).split(';')[0]!;
  };
  const cookie = await session();
  const otherCookie = await session();
  const foreignCookie = await session(1);
  let ip = 1;
  t.beforeEach(() => { ip++; });
  let nextDay = 0;
  const inventory = async (index = 0) => {
    const day = nextDay++;
    const records = [];
    for (let slot = 0; slot < 8; slot++) records.push(await db.availabilitySlot.create({ data: {
      businessId: businesses[index]!.id, staffId: staff[index]!.id,
      startAt: new Date(Date.parse('2030-01-07T23:00:00Z') + day * 86400000 + slot * 1800000),
      endAt: new Date(Date.parse('2030-01-07T23:30:00Z') + day * 86400000 + slot * 1800000),
    } }));
    return records;
  };
  const proposal = async (slots: Awaited<ReturnType<typeof inventory>>, duration = 120, selectedCookie = cookie, index = 0, start = 0) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/customer/booking-proposals', remoteAddress: '127.0.0.' + ip,
      headers: { ...write, cookie: selectedCookie, 'idempotency-key': randomUUID() }, payload: { slotId: slots[start]!.id, serviceId: services[index]!.id, durationMinutes: duration } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { id: string; startAt: string; expiresAt: string };
  };
  const post = (key: string, proposalId: string, details = customer, selectedCookie = cookie, server = app) => server.inject({
    method: 'POST', url: '/api/v1/customer/bookings', remoteAddress: '127.0.0.' + ip,
    headers: { ...write, cookie: selectedCookie, 'idempotency-key': key }, payload: { proposalId, customer: details },
  });
  const get = (id: string, selectedCookie = cookie, server = app) => server.inject({ method: 'GET', url: '/api/v1/customer/bookings/' + id, headers: { cookie: selectedCookie } });
  let initialProposal = '';
  let initialBooking = '';

  await t.test('explicit confirmation atomically reserves four slots and stores safe booking/action/audit', async () => {
    const slots = await inventory();
    const selection = await proposal(slots);
    initialProposal = selection.id;
    const response = await post('success', selection.id);
    assert.equal(response.statusCode, 201, response.body);
    const booking = BookingResponseSchema.parse(response.json());
    initialBooking = booking.id;
    assert.equal(booking.status, 'CONFIRMED');
    assert.equal(Date.parse(booking.endAt) - Date.parse(booking.startAt), 120 * 60000);
    assert.equal(booking.slotId, slots[0]!.id);
    assert.deepEqual(booking.customer, customer);
    assert.match(booking.reference, /^FP-[A-F0-9]{32}$/);
    assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id, releasedAt: null } }), 4);
    assert.equal(await db.availabilitySlot.count({ where: { id: { in: slots.map((slot) => slot.id) }, state: 'RESERVED' } }), 4);
    assert.equal(await db.bookingAction.count({ where: { bookingId: booking.id, operation: 'CONFIRM' } }), 1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: booking.id, eventType: 'BOOKING_CONFIRMED' } });
    assert.equal(audit.traceId, response.headers['x-trace-id']);
    assert.deepEqual(audit.metadata, { durationMinutes: 120 });
    assert.equal(JSON.stringify(audit.metadata).includes(customer.email), false);
    for (const field of ['sessionId', 'idempotencyKey', 'requestFingerprint', 'tokenHash']) assert.equal(field in booking, false);
    assert.deepEqual((await get(booking.id)).json(), booking);
    const availability = await app.inject({ method: 'GET', url: `/api/v1/customer/availability?date=2030-01-08&serviceId=${services[0]!.id}&durationMinutes=30`, headers: { cookie } });
    assert.equal(availability.json().items.some((slot: { slotId: string }) => slots.slice(0, 4).some((item) => item.id === slot.slotId)), false);
  });

  await t.test('cross-instance identical retries create one booking and replay after proposal expiry/setup changes', async () => {
    const slots = await inventory();
    const selection = await proposal(slots, 60);
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => post('parallel', selection.id, customer, cookie, index % 2 ? second : app)));
    assert.equal(results.filter((result) => result.statusCode === 201).length, 1, results.map((result) => result.body).join('\n'));
    assert.equal(results.filter((result) => result.statusCode === 200).length, 5);
    assert.equal(new Set(results.map((result) => result.body)).size, 1);
    const id = results[0]!.json().id;
    assert.equal(await db.booking.count({ where: { proposalId: selection.id } }), 1);
    assert.equal(await db.auditEvent.count({ where: { entityId: id } }), 1);
    assert.equal(await db.bookingSlot.count({ where: { bookingId: id } }), 2);
    now = new Date(+now + 6 * 60000);
    await db.business.update({ where: { id: ids[0]! }, data: { maxBookingDurationMinutes: 30 } });
    await db.service.update({ where: { id: services[0]!.id }, data: { active: false } });
    const replay = await post('parallel', selection.id.toUpperCase(), { name: '  Synthetic Customer  ', email: ' DEMO@EXAMPLE.TEST ' }, cookie, second);
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), results[0]!.json());
    assert.deepEqual((await get(id, cookie, second)).json(), results[0]!.json());
    await db.business.update({ where: { id: ids[0]! }, data: { maxBookingDurationMinutes: 120 } });
    await db.service.update({ where: { id: services[0]!.id }, data: { active: true } });
    now = new Date('2030-01-07T22:00:00Z');
  });

  await t.test('conflicting customer payloads and competing keys cannot consume one proposal twice', async () => {
    const selection = await proposal(await inventory(), 30);
    const results = await Promise.all([
      post('conflict', selection.id), post('conflict', selection.id, { ...customer, name: 'Another Synthetic Customer' }, cookie, second),
    ]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409]);
    assert.equal(results.find((result) => result.statusCode === 409)!.json().code, 'IDEMPOTENCY_CONFLICT');
    const another = await proposal(await inventory(), 30);
    const competing = await Promise.all([post('key-a', another.id), post('key-b', another.id, customer, cookie, second)]);
    assert.deepEqual(competing.map((result) => result.statusCode).sort(), [201, 409]);
    assert.equal(competing.find((result) => result.statusCode === 409)!.json().code, 'PROPOSAL_ALREADY_USED');
    assert.equal(await db.booking.count({ where: { proposalId: another.id } }), 1);
  });

  await t.test('overlapping long/short customer confirmations produce one winner without partial claims', async () => {
    const slots = await inventory();
    const long = await proposal(slots, 120);
    const short = await proposal(slots, 30, otherCookie, 0, 1);
    const results = await Promise.all([post('overlap-long', long.id), post('overlap-short', short.id, customer, otherCookie, second)]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409]);
    const failed = results.find((result) => result.statusCode === 409)!;
    assert.equal(failed.json().code, 'SLOT_UNAVAILABLE');
    const winner = results.find((result) => result.statusCode === 201)!.json();
    const wonLong = winner.durationMinutes === 120;
    assert.equal(await db.booking.count({ where: { proposalId: { in: [long.id, short.id] } } }), 1);
    assert.equal(await db.availabilitySlot.count({ where: { id: { in: slots.map((slot) => slot.id) }, state: 'RESERVED' } }), wonLong ? 4 : 1);
    assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slots[0]!.id } })).state, wonLong ? 'RESERVED' : 'AVAILABLE');
    assert.equal(await db.bookingAction.count({ where: { proposalId: wonLong ? short.id : long.id, operation: 'CONFIRM' } }), 0);
  });

  await t.test('owned reads and confirmations never cross customer/business boundaries', async () => {
    const owned = await proposal(await inventory(), 30);
    assert.equal((await post('foreign-customer', owned.id, customer, otherCookie)).statusCode, 404);
    assert.equal((await post('foreign-business', owned.id, customer, foreignCookie)).statusCode, 404);
    assert.equal((await get(initialBooking, otherCookie)).statusCode, 404);
    assert.equal((await get(initialBooking, foreignCookie)).statusCode, 404);
    assert.equal((await get(randomUUID())).statusCode, 404);
    assert.equal((await get('not-a-uuid')).statusCode, 400);
    assert.equal((await get(initialBooking, 'flowpilot_session=' + 'a'.repeat(64))).statusCode, 401);
    assert.equal((await get(initialBooking + '?businessId=' + ids[1])).statusCode, 400);
    const foreign = await proposal(await inventory(1), 30, foreignCookie, 1);
    const response = await post('success', foreign.id, customer, foreignCookie);
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().businessId, ids[1]);
    assert.equal((await get(response.json().id, cookie)).statusCode, 404);
    assert.equal((await get(response.json().id, foreignCookie)).statusCode, 200);
  });

  await t.test('confirmation requires dedicated strict request, key, session and permitted origin', async () => {
    const selection = await proposal(await inventory(), 30);
    const base = { proposalId: selection.id, customer };
    for (const patch of [{ confirmed: true }, { status: 'CONFIRMED' }, { slotId: randomUUID() }, { businessId: ids[1] }]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/customer/bookings', remoteAddress: '127.0.0.' + ip,
        headers: { ...write, cookie, 'idempotency-key': 'strict' }, payload: { ...base, ...patch } });
      assert.equal(response.statusCode, 400);
    }
    assert.equal((await post('invalid-email', selection.id, { ...customer, email: 'real@example.com' })).statusCode, 400);
    assert.equal((await post('no-session', selection.id, customer, '')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/customer/bookings', headers: { cookie, 'idempotency-key': 'origin' }, payload: base })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/customer/bookings', headers: { ...write, cookie }, payload: base })).statusCode, 400);
    assert.equal(await db.booking.count({ where: { proposalId: selection.id } }), 0);
  });

  await t.test('expired proposals and elapsed starts fail; failed keys remain reusable', async () => {
    const slots = await inventory();
    const selection = await proposal(slots, 30);
    now = new Date(selection.expiresAt);
    assert.equal((await post('expired', selection.id)).json().code, 'PROPOSAL_EXPIRED');
    now = new Date('2030-01-07T22:00:00Z');
    const fresh = await proposal(slots, 30);
    assert.equal((await post('expired', fresh.id)).statusCode, 201);
    // Create a proposal one minute before its start to test elapsed time before expiry.
    // Keep session valid by testing near the first fixture day's next free slot.
    const firstDay = await db.availabilitySlot.findMany({ where: { businessId: ids[0]!, startAt: { gte: new Date('2030-01-08T01:00:00Z'), lt: new Date('2030-01-08T03:00:00Z') } }, orderBy: { startAt: 'asc' } });
    assert.ok(firstDay.length > 0);
    now = new Date(+firstDay[0]!.startAt - 60000);
    const near = await proposal(firstDay, 30);
    now = new Date(near.startAt);
    assert.equal((await post('elapsed', near.id)).json().code, 'SLOT_UNAVAILABLE');
    now = new Date('2030-01-07T22:00:00Z');
  });

  await t.test('new execution revalidates active setup and the current maximum', async () => {
    const selection = await proposal(await inventory(), 120);
    await db.business.update({ where: { id: ids[0]! }, data: { maxBookingDurationMinutes: 60 } });
    assert.equal((await post('limit', selection.id)).json().code, 'DURATION_NOT_ALLOWED');
    await db.business.update({ where: { id: ids[0]! }, data: { maxBookingDurationMinutes: 120 } });
    await db.service.update({ where: { id: services[0]!.id }, data: { active: false } });
    assert.equal((await post('inactive-service', selection.id)).json().code, 'SELECTION_UNAVAILABLE');
    await db.service.update({ where: { id: services[0]!.id }, data: { active: true } });
    await db.staff.update({ where: { id: staff[0]!.id }, data: { active: false } });
    assert.equal((await post('inactive-staff', selection.id)).json().code, 'SELECTION_UNAVAILABLE');
    await db.staff.update({ where: { id: staff[0]!.id }, data: { active: true } });
    assert.equal(await db.booking.count({ where: { proposalId: selection.id } }), 0);
  });

  await t.test('partial claim and audit failure roll back slots, consumption, booking, action and audit', async () => {
    const slots = await inventory();
    const selection = await proposal(slots, 120);
    await db.availabilitySlot.update({ where: { id: slots[2]!.id }, data: { state: 'BLOCKED' } });
    const before = await db.availabilitySlot.findMany({ where: { id: { in: slots.map((slot) => slot.id) } }, orderBy: { id: 'asc' } });
    assert.equal((await post('partial', selection.id)).json().code, 'SLOT_UNAVAILABLE');
    assert.deepEqual(await db.availabilitySlot.findMany({ where: { id: { in: slots.map((slot) => slot.id) } }, orderBy: { id: 'asc' } }), before);
    await db.availabilitySlot.update({ where: { id: slots[2]!.id }, data: { state: 'AVAILABLE' } });
    const badRequest = { cookies: { flowpilot_customer_session: cookie.split('=')[1] }, id: undefined } as unknown as FastifyRequest;
    await assert.rejects(confirmBooking(db, badRequest, { proposalId: selection.id, customer }, 'rollback', clock));
    assert.equal(await db.booking.count({ where: { proposalId: selection.id } }), 0);
    assert.equal(await db.bookingAction.count({ where: { proposalId: selection.id, operation: 'CONFIRM' } }), 0);
    assert.equal(await db.availabilitySlot.count({ where: { id: { in: slots.map((slot) => slot.id) }, state: 'RESERVED' } }), 0);
    assert.equal((await post('rollback', selection.id)).statusCode, 201);
  });

  await t.test('expired/revoked sessions and inactive businesses deny replay and owned reads', async () => {
    now = new Date('2030-01-08T06:00:00Z');
    assert.equal((await post('success', initialProposal)).statusCode, 401);
    assert.equal((await get(initialBooking)).statusCode, 401);
    now = new Date('2030-01-07T22:00:00Z');
    await db.business.update({ where: { id: ids[0]! }, data: { active: false } });
    assert.equal((await post('success', initialProposal)).statusCode, 401);
    assert.equal((await get(initialBooking)).statusCode, 401);
    await db.business.update({ where: { id: ids[0]! }, data: { active: true } });
    const tokenHash = createHash('sha256').update(cookie.split('=')[1]!).digest('hex');
    await db.customerSession.update({ where: { tokenHash }, data: { revokedAt: now } });
    assert.equal((await post('success', initialProposal)).statusCode, 401);
    assert.equal((await get(initialBooking)).statusCode, 401);
  });
});
