import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { createDatabaseClient, localBusinessInstant } from '@flowpilot/db';
import { BookingProposalResponseSchema } from '@flowpilot/contracts';
import { buildApp } from './app.js';
import { createBookingProposal } from './booking-proposal-service.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Use the dedicated local flowpilot_test database.');
}
const origin = 'http://127.0.0.1:5173';
const writeHeaders = { origin, 'x-flowpilot-client': 'web' };

test('Phase 2 immutable idempotent booking proposals', async (t) => {
  const db = createDatabaseClient(url);
  const tag = randomUUID();
  let now = new Date('2030-01-07T22:00:00Z');
  const clock = () => new Date(now);
  const app = buildApp({ db, clock });
  const secondApp = buildApp({ db, clock });
  const businesses = await Promise.all(['a', 'b'].map((suffix) => db.business.create({ data: {
    slug: 'proposal-' + tag + suffix, name: 'Synthetic ' + suffix, timezone: 'Australia/Brisbane',
  } })));
  const a = businesses[0]!;
  const b = businesses[1]!;
  const ids = businesses.map((business) => business.id);
  t.after(async () => {
    await app.close(); await secondApp.close();
    try {
      await db.auditEvent.deleteMany({ where: { businessId: { in: ids } } });
      await db.bookingAction.deleteMany({ where: { businessId: { in: ids } } });
      await db.bookingProposal.deleteMany({ where: { businessId: { in: ids } } });
      await db.customerSession.deleteMany({ where: { businessId: { in: ids } } });
      await db.availabilitySlot.deleteMany({ where: { businessId: { in: ids } } });
      await db.service.deleteMany({ where: { businessId: { in: ids } } });
      await db.staff.deleteMany({ where: { businessId: { in: ids } } });
      await db.business.deleteMany({ where: { id: { in: ids } } });
    } finally { await db.$disconnect(); }
  });
  const staff = await Promise.all(businesses.map((business) => db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex ' + business.slug } })));
  const services = await Promise.all(businesses.map((business) => db.service.create({ data: { businessId: business.id, slug: 'consultation', name: 'Consultation' } })));
  for (let index = 0; index < 2; index++) {
    await db.availabilitySlot.createMany({ data: [540, 570, 600, 630, 660, 690, 780, 810, 840, 870].map((minute) => {
      const startAt = localBusinessInstant('2030-01-08', 'Australia/Brisbane', Math.floor(minute / 60), minute % 60);
      return { businessId: businesses[index]!.id, staffId: staff[index]!.id, startAt, endAt: new Date(+startAt + 1800000) };
    }) });
  }
  const slots = await db.availabilitySlot.findMany({ where: { businessId: a.id }, orderBy: { startAt: 'asc' } });
  const foreignSlot = await db.availabilitySlot.findFirstOrThrow({ where: { businessId: b.id } });
  const bootstrap = async (slug: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers: writeHeaders, payload: { businessSlug: slug } });
    assert.equal(response.statusCode, 201);
    return String(response.headers['set-cookie']).split(';')[0]!;
  };
  const cookie = await bootstrap(a.slug);
  const otherCookie = await bootstrap(a.slug);
  const foreignCookie = await bootstrap(b.slug);
  let ip = 1;
  t.beforeEach(() => { ip++; });
  const body = { slotId: slots[0]!.id, serviceId: services[0]!.id, durationMinutes: 120 };
  const post = (key: string, payload: Record<string, unknown> = body, sessionCookie = cookie, server = app) => server.inject({
    method: 'POST', url: '/api/v1/customer/booking-proposals', remoteAddress: '127.0.0.' + ip,
    headers: { ...writeHeaders, cookie: sessionCookie, 'idempotency-key': key }, payload,
  });

  await t.test('strict input, mandatory stable keys, customer authentication and origin guards', async () => {
    assert.equal((await post('no-auth', body, '')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/customer/booking-proposals', headers: { cookie, 'idempotency-key': 'origin' }, payload: body })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/customer/booking-proposals', headers: { ...writeHeaders, cookie }, payload: body })).statusCode, 400);
    for (const key of ['', 'bad key', 'x'.repeat(129)]) assert.equal((await post(key)).statusCode, 400);
    for (const patch of [{ confirmed: true }, { businessId: b.id }, { sessionId: randomUUID() }, { startAt: now.toISOString() }, { durationMinutes: 45 }]) {
      assert.equal((await post('invalid', { ...body, ...patch })).statusCode, 400);
    }
    const override = await app.inject({ method: 'POST', url: '/api/v1/customer/booking-proposals?businessId=' + b.id,
      headers: { ...writeHeaders, cookie, 'idempotency-key': 'query' }, payload: body });
    assert.equal(override.statusCode, 400);
    assert.equal(await db.bookingProposal.count({ where: { businessId: a.id } }), 0);
  });

  await t.test('trusted five-minute snapshot, action and minimal audit are saved without holds', async () => {
    const before = await db.availabilitySlot.findMany({ where: { businessId: a.id }, orderBy: { id: 'asc' } });
    const response = await post('saved');
    assert.equal(response.statusCode, 201, response.body);
    const proposal = BookingProposalResponseSchema.parse(response.json());
    assert.equal(proposal.businessId, a.id);
    assert.equal(proposal.staffId, staff[0]!.id);
    assert.equal(proposal.startAt, '2030-01-07T23:00:00.000Z');
    assert.equal(proposal.endAt, '2030-01-08T01:00:00.000Z');
    assert.equal(proposal.createdAt, now.toISOString());
    assert.equal(proposal.expiresAt, '2030-01-07T22:05:00.000Z');
    const action = await db.bookingAction.findFirstOrThrow({ where: { proposalId: proposal.id } });
    assert.equal(action.operation, 'PROPOSE');
    assert.equal(action.bookingId, null);
    assert.match(action.requestFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(action.response, proposal);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { businessId: a.id, entityId: proposal.id } });
    assert.equal(audit.eventType, 'BOOKING_PROPOSED');
    assert.equal(audit.traceId, response.headers['x-trace-id']);
    assert.equal(audit.actorType, 'SYSTEM');
    assert.equal(audit.actorId, null);
    assert.deepEqual(audit.metadata, { durationMinutes: 120 });
    assert.equal('sessionId' in proposal, false);
    assert.equal(response.body.includes(cookie.split('=')[1]!), false);
    assert.deepEqual(await db.availabilitySlot.findMany({ where: { businessId: a.id }, orderBy: { id: 'asc' } }), before);
    assert.equal(await db.booking.count({ where: { businessId: a.id } }), 0);
  });

  await t.test('replay preserves snapshots after expiry/setup changes and across app instances', async () => {
    const original = await post('replay');
    assert.equal(original.statusCode, 201);
    now = new Date(+now + 6 * 60000);
    await db.service.update({ where: { id: services[0]!.id }, data: { active: false, name: 'Changed label' } });
    await db.availabilitySlot.update({ where: { id: slots[1]!.id }, data: { state: 'BLOCKED' } });
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 30 } });
    const replay = await post('replay', { durationMinutes: 120, serviceId: body.serviceId.toUpperCase(), slotId: body.slotId.toUpperCase() }, cookie, secondApp);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), original.json());
    assert.equal(await db.bookingAction.count({ where: { proposalId: original.json().id } }), 1);
    assert.equal(await db.auditEvent.count({ where: { entityId: original.json().id } }), 1);
    assert.equal((await post('replay', { ...body, durationMinutes: 60 })).json().code, 'IDEMPOTENCY_CONFLICT');
    await db.service.update({ where: { id: services[0]!.id }, data: { active: true, name: 'Consultation' } });
    await db.availabilitySlot.update({ where: { id: slots[1]!.id }, data: { state: 'AVAILABLE' } });
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 120 } });
    now = new Date('2030-01-07T22:00:00Z');
  });

  await t.test('concurrent identical retries across instances converge on one transaction result', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => post('parallel', body, cookie, index % 2 ? secondApp : app)));
    assert.equal(responses.filter((response) => response.statusCode === 201).length, 1);
    assert.equal(responses.filter((response) => response.statusCode === 200).length, 5);
    assert.equal(new Set(responses.map((response) => response.json().id)).size, 1);
    assert.ok(responses.every((response) => response.body === responses[0]!.body));
    const id = responses[0]!.json().id;
    assert.equal(await db.bookingProposal.count({ where: { id } }), 1);
    assert.equal(await db.bookingAction.count({ where: { proposalId: id } }), 1);
    assert.equal(await db.auditEvent.count({ where: { entityId: id } }), 1);
  });

  await t.test('concurrent conflicting payloads yield one success and one key conflict', async () => {
    const results = await Promise.all([post('conflicting'), post('conflicting', { ...body, durationMinutes: 60 }, cookie, secondApp)]);
    assert.deepEqual(results.map((response) => response.statusCode).sort(), [201, 409]);
    const conflict = results.find((response) => response.statusCode === 409)!;
    assert.equal(conflict.json().code, 'IDEMPOTENCY_CONFLICT');
  });

  await t.test('keys and selections cannot cross customer or business ownership', async () => {
    const first = await post('shared');
    const other = await post('shared', body, otherCookie);
    const foreign = await post('shared', { slotId: foreignSlot.id, serviceId: services[1]!.id, durationMinutes: 30 }, foreignCookie);
    assert.equal(first.statusCode, 201); assert.equal(other.statusCode, 201); assert.equal(foreign.statusCode, 201);
    assert.equal(new Set([first.json().id, other.json().id, foreign.json().id]).size, 3);
    assert.equal((await post('foreign-service', { ...body, serviceId: services[1]!.id })).statusCode, 404);
    assert.equal((await post('foreign-slot', { ...body, slotId: foreignSlot.id })).statusCode, 404);
    assert.equal((await post('shared', body, foreignCookie)).json().code, 'IDEMPOTENCY_CONFLICT');
  });

  await t.test('new proposals reject limits, inactive resources, breaks, partial inventory and past starts', async () => {
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 60 } });
    assert.equal((await post('limit')).json().code, 'DURATION_NOT_ALLOWED');
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 120 } });
    assert.equal((await post('gap', { ...body, slotId: slots[3]!.id })).json().code, 'SLOT_UNAVAILABLE');
    for (const state of ['RESERVED', 'BLOCKED'] as const) {
      await db.availabilitySlot.update({ where: { id: slots[1]!.id }, data: { state } });
      assert.equal((await post('partial-' + state)).json().code, 'SLOT_UNAVAILABLE');
    }
    await db.availabilitySlot.update({ where: { id: slots[1]!.id }, data: { state: 'AVAILABLE' } });
    await db.staff.update({ where: { id: staff[0]!.id }, data: { active: false } });
    assert.equal((await post('inactive-staff')).statusCode, 404);
    await db.staff.update({ where: { id: staff[0]!.id }, data: { active: true } });
    await db.service.update({ where: { id: services[0]!.id }, data: { active: false } });
    assert.equal((await post('inactive-service')).statusCode, 404);
    await db.service.update({ where: { id: services[0]!.id }, data: { active: true } });
    now = new Date('2030-01-07T23:00:00Z');
    assert.equal((await post('past')).json().code, 'SLOT_UNAVAILABLE');
    now = new Date('2030-01-07T22:00:00Z');
    for (const key of ['limit', 'gap', 'partial-RESERVED', 'partial-BLOCKED', 'inactive-staff', 'inactive-service', 'past']) {
      assert.equal(await db.bookingAction.count({ where: { businessId: a.id, idempotencyKey: key } }), 0);
    }
  });

  await t.test('audit persistence failure rolls back proposal/action and does not consume its key', async () => {
    const request = { cookies: { flowpilot_customer_session: cookie.split('=')[1] }, id: undefined } as unknown as FastifyRequest;
    const before = await db.bookingProposal.count({ where: { businessId: a.id } });
    await assert.rejects(createBookingProposal(db, request, body, 'rollback', clock));
    assert.equal(await db.bookingProposal.count({ where: { businessId: a.id } }), before);
    assert.equal(await db.bookingAction.count({ where: { businessId: a.id, idempotencyKey: 'rollback' } }), 0);
    assert.equal((await post('rollback')).statusCode, 201);
  });

  await t.test('replay still requires a live customer and active business', async () => {
    assert.equal((await post('auth-replay')).statusCode, 201);
    now = new Date('2030-01-08T06:00:00Z');
    assert.equal((await post('auth-replay')).statusCode, 401);
    now = new Date('2030-01-07T22:00:00Z');
    await db.business.update({ where: { id: a.id }, data: { active: false } });
    assert.equal((await post('auth-replay')).statusCode, 401);
    await db.business.update({ where: { id: a.id }, data: { active: true } });
    const tokenHash = createHash('sha256').update(cookie.split('=')[1]!).digest('hex');
    await db.customerSession.update({ where: { tokenHash }, data: { revokedAt: now } });
    assert.equal((await post('auth-replay')).statusCode, 401);
  });
});
