import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { createDatabaseClient } from '@flowpilot/db';
import { buildApp } from './app.js';
import { rescheduleBooking } from './booking-reschedule.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Dedicated local test database required.');
const headers = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };
test('Phase 5 Step 4 atomic scoped overlapping rescheduling', async (t) => {
  const db = createDatabaseClient(url); let now = new Date('2030-01-07T22:00Z'); const clock = () => new Date(now); const app = buildApp({ db, clock }); const other = buildApp({ db, clock }); const tag = randomUUID();
  const businesses = await Promise.all(['a', 'b'].map((part) => db.business.create({ data: { slug: `move-${tag}-${part}`, name: 'Synthetic' } }))); const business = businesses[0]!; const ids = businesses.map((row) => row.id);
  const staff = await db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } }); const service = await db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } });
  t.after(async () => { await app.close(); await other.close(); try { await db.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingAction.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingSlot.deleteMany({ where: { businessId: { in: ids } } });
    await tx.booking.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingProposal.deleteMany({ where: { businessId: { in: ids } } }); await tx.customerSession.deleteMany({ where: { businessId: { in: ids } } });
    await tx.availabilitySlot.deleteMany({ where: { businessId: { in: ids } } }); await tx.staff.deleteMany({ where: { businessId: { in: ids } } }); await tx.service.deleteMany({ where: { businessId: { in: ids } } }); await tx.business.deleteMany({ where: { id: { in: ids } } });
  }); } finally { await db.$disconnect(); } });
  const cookies: string[] = [];
  for (const i of [0, 0, 1]) { const response = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers, payload: { businessSlug: businesses[i]!.slug } }); cookies.push(String(response.headers['set-cookie']).split(';')[0]!); }
  await db.customerSession.updateMany({ where: { businessId: { in: ids } }, data: { expiresAt: new Date('2031-01-01T00:00Z') } });
  let ip = 1; let day = 0;
  const post = (path: string, payload: object, key: string = randomUUID(), cookie = cookies[0]!, server = app) => server.inject({ method: 'POST', url: '/api/v1/customer/' + path, remoteAddress: `127.0.8.${ip++}`, headers: { ...headers, cookie, 'idempotency-key': key }, payload });
  const fixture = async () => { const slots = []; const start = Date.parse('2030-01-07T23:00Z') + day++ * 86400000;
    for (let n = 0; n < 8; n++) slots.push(await db.availabilitySlot.create({ data: { businessId: business.id, staffId: staff.id, startAt: new Date(start + n * 1800000), endAt: new Date(start + (n + 1) * 1800000) } }));
    const response = await post('booking-proposals', { slotId: slots[0]!.id, serviceId: service.id, durationMinutes: 60 }); assert.equal(response.statusCode, 201);
    const booking = await post('bookings', { proposalId: response.json().id, customer: { name: 'Synthetic', email: 'demo@example.test' } }); assert.equal(booking.statusCode, 201);
    return { slots, booking: booking.json() as { id: string; reference: string; startAt: string } };
  };
  const proposal = async (id: string, slotId: string, durationMinutes = 120) => { const result = await post(`bookings/${id}/reschedule-proposals`, { slotId, serviceId: service.id, durationMinutes }); assert.equal(result.statusCode, 201, result.body); return result.json() as { id: string }; };
  const move = (id: string, proposalId: string, key: string = randomUUID(), cookie = cookies[0]!, server = app) => post(`bookings/${id}/reschedule`, { proposalId }, key, cookie, server);
  await t.test('owned overlap availability and proposal binding cannot cross business/customer or normal confirmation', async () => {
    const { slots, booking } = await fixture();
    const date = '2030-01-08'; const query = `availability?date=${date}&serviceId=${service.id}&durationMinutes=120&rescheduleBookingId=${booking.id}`;
    const result = await app.inject({ method: 'GET', url: '/api/v1/customer/' + query, headers: { cookie: cookies[0]! } }); assert.equal(result.statusCode, 200); assert.equal(result.json().pagination.total, 5);
    for (const cookie of cookies.slice(1)) { assert.equal((await app.inject({ method: 'GET', url: '/api/v1/customer/' + query, headers: { cookie } })).statusCode, 404); assert.equal((await move(booking.id, randomUUID(), randomUUID(), cookie)).statusCode, 404); }
    const selected = await proposal(booking.id, slots[1]!.id);
    const source = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    await assert.rejects(db.booking.create({ data: { businessId: business.id, sessionId: source.sessionId, proposalId: selected.id, reference: 'FP-' + randomUUID().replaceAll('-','').toUpperCase(), customerName: 'Synthetic', customerEmail: 'demo@example.test' } }), /released owned source/);
    assert.equal((await post('bookings', { proposalId: selected.id, customer: { name: 'Synthetic', email: 'demo@example.test' } })).json().code, 'BOOKING_NOT_CHANGEABLE');
    const normal = await post('booking-proposals', { slotId: slots[4]!.id, serviceId: service.id, durationMinutes: 30 }); assert.equal(normal.statusCode, 201);
    assert.equal((await move(booking.id, normal.json().id)).statusCode, 404);
    for (const body of [{ proposalId: selected.id, confirmed: true }, { proposalId: selected.id, customer: {} }, { proposalId: selected.id, businessId: business.id }]) assert.equal((await post(`bookings/${booking.id}/reschedule`, body)).statusCode, 400);
  });
  await t.test('overlap atomically preserves original links and claims complete replacement with durable chain/retries', async () => {
    const { slots, booking } = await fixture(); const selected = await proposal(booking.id, slots[1]!.id); const key = randomUUID();
    const results = await Promise.all([move(booking.id, selected.id, key), move(booking.id, selected.id, key, cookies[0]!, other)]);
    assert.ok(results.every((row) => row.statusCode === 200), results.map((row) => row.body).join('\n')); assert.deepEqual(results[0]!.json(), results[1]!.json());
    const next = results[0]!.json(); assert.equal(next.rescheduledFromId, booking.id); assert.notEqual(next.id, booking.id);
    const template = await db.bookingProposal.findUniqueOrThrow({ where: { id: selected.id } });
    const duplicate = await db.bookingProposal.create({ data: { ...template, id: randomUUID() } });
    await assert.rejects(db.booking.create({ data: { businessId: business.id, sessionId: template.sessionId, proposalId: duplicate.id, reference: 'FP-' + randomUUID().replaceAll('-','').toUpperCase(), customerName: 'Synthetic', customerEmail: 'demo@example.test' } }), /only one replacement successor/);
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'CANCELLED'); assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id } }), 2); assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id, releasedAt: null } }), 0);
    assert.equal(await db.bookingSlot.count({ where: { bookingId: next.id, releasedAt: null } }), 4); assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slots[0]!.id } })).state, 'AVAILABLE');
    assert.equal((await move(booking.id, selected.id)).json().code, 'BOOKING_NOT_CHANGEABLE'); assert.equal((await move(booking.id, randomUUID(), key)).json().code, 'IDEMPOTENCY_CONFLICT');
    const restart = buildApp({ db, clock }); try { assert.deepEqual((await move(booking.id, selected.id, key, cookies[0]!, restart)).json(), next); } finally { await restart.close(); }
  });
  await t.test('failed replacement claim or audit fully restores original and does not consume key', async () => {
    const { slots, booking } = await fixture(); const selected = await proposal(booking.id, slots[2]!.id); const key = randomUUID();
    await db.availabilitySlot.update({ where: { id: slots[3]!.id }, data: { state: 'BLOCKED' } });
    assert.equal((await move(booking.id, selected.id, key)).json().code, 'SLOT_UNAVAILABLE'); assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id, releasedAt: null } }), 2);
    await db.availabilitySlot.update({ where: { id: slots[3]!.id }, data: { state: 'AVAILABLE' } });
    const bad = { cookies: { flowpilot_customer_session: cookies[0]!.split('=')[1] }, id: undefined } as unknown as FastifyRequest;
    await assert.rejects(rescheduleBooking(db, bad, booking.id, selected.id, key, clock)); assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'CONFIRMED');
    assert.equal(await db.bookingAction.count({ where: { operation: 'RESCHEDULE', idempotencyKey: key } }), 0); assert.equal((await move(booking.id, selected.id, key)).statusCode, 200);
  });
  await t.test('expiry, started original, reduced maximum and inactive target preserve original', async () => {
    const { slots, booking } = await fixture(); const selected = await proposal(booking.id, slots[2]!.id); const before = now;
    now = new Date(+now + 300001); assert.equal((await move(booking.id, selected.id)).json().code, 'PROPOSAL_EXPIRED'); now = before;
    await db.business.update({ where: { id: business.id }, data: { maxBookingDurationMinutes: 30 } }); assert.equal((await move(booking.id, selected.id)).json().code, 'DURATION_NOT_ALLOWED'); await db.business.update({ where: { id: business.id }, data: { maxBookingDurationMinutes: 120 } });
    await db.staff.update({ where: { id: staff.id }, data: { active: false } }); assert.equal((await move(booking.id, selected.id)).json().code, 'SELECTION_UNAVAILABLE'); await db.staff.update({ where: { id: staff.id }, data: { active: true } });
    assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id, releasedAt: null } }), 2);
    now = new Date(booking.startAt); const result = await move(booking.id, selected.id); assert.equal(result.statusCode, 409); now = before;
  });
  await t.test('competing replacements and cancellation serialize to one effect without losing claims', async () => {
    const { slots, booking } = await fixture(); const first = await proposal(booking.id, slots[1]!.id); const second = await proposal(booking.id, slots[4]!.id);
    const results = await Promise.all([move(booking.id, first.id), move(booking.id, second.id)]); assert.deepEqual(results.map((row) => row.statusCode).sort(), [200, 409]);
    const winner = results.find((row) => row.statusCode === 200)!.json(); assert.equal(await db.bookingSlot.count({ where: { bookingId: winner.id, releasedAt: null } }), 4);
    const otherFixture = await fixture(); const target = await proposal(otherFixture.booking.id, otherFixture.slots[2]!.id);
    const race = await Promise.all([move(otherFixture.booking.id, target.id), post(`bookings/${otherFixture.booking.id}/cancel`, {})]); assert.equal(race[1]!.statusCode, 200); assert.ok([200, 409].includes(race[0]!.statusCode));
  });
});
