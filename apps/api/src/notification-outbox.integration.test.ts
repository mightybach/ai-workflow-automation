import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { createDatabaseClient, hashPassword, Prisma } from '@flowpilot/db';
import { BookingNotificationEventSchema } from '@flowpilot/contracts';
import { buildApp } from './app.js';
import { confirmBooking } from './booking-service.js';
import { cancelBooking } from './booking-cancellation.js';
import { rescheduleBooking } from './booking-reschedule.js';
import { processMockNotification, InvalidNotification } from './notification-worker.js';
import { claimNextEvent, finishEventLease, eventFromRow, publishOutboxBatch, PublishFailure } from './outbox-publisher.js';
import { connect } from 'amqplib';
import { RabbitMqPublisher } from './rabbitmq-publisher.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MOCK_NOTIFICATION_QUEUE } from '@flowpilot/contracts';
import type { GetMessage } from 'amqplib';
import { handleNotificationDelivery } from './notification-delivery.js';
import { scheduleMockReminders, setMockReminderPolicy } from './mock-reminders.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use dedicated local flowpilot_test.');
const headers = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };
const customer = { name: 'Synthetic', email: 'demo@example.test' };

test('Phase 6 atomic outbox, publication and idempotent mock consumption', async (t) => {
  const db = createDatabaseClient(url); const tag = randomUUID(); const now = new Date('2030-01-07T22:00Z'); const clock = () => new Date(now);
  const app = buildApp({ db, clock, demoAuthEnabled: true }); const other = buildApp({ db, clock });
  const businesses = await Promise.all(['a', 'b'].map((suffix) => db.business.create({ data: { slug: `outbox-${tag}-${suffix}`, name: 'Synthetic Outbox' } }))); const ids = businesses.map((row) => row.id); const a = businesses[0]!;
  const staff = await Promise.all(businesses.map((business) => db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } })));
  const services = await Promise.all(businesses.map((business) => db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } })));
  const password = 'synthetic-outbox-password'; const user = await db.user.create({ data: { email: `outbox-${tag}@example.test`, role: 'CLIENT', passwordHash: await hashPassword(password) } });
  await db.businessMembership.create({ data: { businessId: a.id, userId: user.id, role: 'OWNER' } });
  t.after(async () => { await app.close(); await other.close(); try { await db.$transaction(async (tx) => {
    await tx.notificationOutbox.deleteMany({ where: { businessId: { in: ids } } }); await tx.auditEvent.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingAction.deleteMany({ where: { businessId: { in: ids } } });
    await tx.bookingSlot.deleteMany({ where: { businessId: { in: ids } } }); await tx.booking.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingProposal.deleteMany({ where: { businessId: { in: ids } } });
    await tx.customerSession.deleteMany({ where: { businessId: { in: ids } } }); await tx.availabilitySlot.deleteMany({ where: { businessId: { in: ids } } }); await tx.staff.deleteMany({ where: { businessId: { in: ids } } }); await tx.service.deleteMany({ where: { businessId: { in: ids } } });
    await tx.businessMembership.deleteMany({ where: { businessId: { in: ids } } }); await tx.business.deleteMany({ where: { id: { in: ids } } }); await tx.user.delete({ where: { id: user.id } });
  }); } finally { await db.$disconnect(); } });
  const cookies: string[] = [];
  for (const business of businesses) { const response = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers, payload: { businessSlug: business.slug } }); assert.equal(response.statusCode, 201); cookies.push(String(response.headers['set-cookie']).split(';')[0]!); }
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: user.email, password } }); assert.equal(login.statusCode, 200); const ownerCookie = String(login.headers['set-cookie']).split(';')[0]!;
  let ip = 1; let day = 0;
  const post = (path: string, payload: object, key: string = randomUUID(), index = 0, server = app) => server.inject({ method: 'POST', url: '/api/v1/customer/' + path, remoteAddress: `127.0.10.${ip++}`, headers: { ...headers, cookie: cookies[index]!, 'idempotency-key': key }, payload });
  const fixture = async (index = 0) => {
    const start = Date.parse('2030-01-07T23:00Z') + day++ * 86400000; const parts = [];
    for (let n = 0; n < 6; n++) parts.push(await db.availabilitySlot.create({ data: { businessId: businesses[index]!.id, staffId: staff[index]!.id, startAt: new Date(start + n * 1800000), endAt: new Date(start + (n + 1) * 1800000) } }));
    const selected = await post('booking-proposals', { slotId: parts[0]!.id, serviceId: services[index]!.id, durationMinutes: 60 }, randomUUID(), index); assert.equal(selected.statusCode, 201, selected.body);
    return { parts, proposalId: selected.json().id as string, body: { proposalId: selected.json().id as string, customer } };
  };
  const book = async (index = 0) => { const value = await fixture(index); const key = randomUUID(); const response = await post('bookings', value.body, key, index); assert.equal(response.statusCode, 201, response.body); return { ...value, key, booking: response.json() as { id: string } }; };
  const invalidRequest = { cookies: { flowpilot_customer_session: cookies[0]!.split('=')[1] }, id: ' ' } as unknown as FastifyRequest;
  const events = (bookingId: string) => db.notificationOutbox.findMany({ where: { bookingId }, orderBy: { eventType: 'asc' } });
  const moveProposal = async (bookingId: string, slotId: string) => { const response = await post(`bookings/${bookingId}/reschedule-proposals`, { slotId, serviceId: services[0]!.id, durationMinutes: 120 }); assert.equal(response.statusCode, 201); return response.json().id as string; };
  await t.test('proposal is not an event; confirmation and all cross-instance retries persist one minimal pending identity', async () => {
    const value = await fixture(); assert.equal(await db.notificationOutbox.count({ where: { businessId: a.id } }), 0);
    const key = randomUUID(); const results = await Promise.all([post('bookings', value.body, key), post('bookings', value.body, key, 0, other)]); assert.deepEqual(results.map((row) => row.statusCode).sort(), [200, 201]);
    const id = results[0]!.json().id as string; const rows = await events(id); assert.equal(rows.length, 1); const row = rows[0]!;
    const envelope = BookingNotificationEventSchema.parse({ eventId: row.id, schemaVersion: row.schemaVersion, eventType: row.eventType, deliveryMode: row.deliveryMode, businessId: row.businessId, bookingId: row.bookingId, previousBookingId: row.previousBookingId, occurredAt: row.occurredAt.toISOString(), traceId: row.traceId });
    assert.equal(row.status, 'PENDING'); assert.equal(row.attempts, 0); assert.equal(row.publishedAt, null); assert.equal(row.leaseToken, null); assert.equal(row.previousBookingId, null);
    assert.equal(row.deliveryMode, 'MOCK'); assert.equal(row.businessId, a.id); assert.equal(row.traceId, results.find((item) => item.statusCode === 201)!.headers['x-trace-id']);
    assert.equal(JSON.stringify(envelope).includes('example.test'), false); for (const field of ['customerName', 'customerEmail', 'message', 'tokenHash', 'idempotencyKey', 'payload']) assert.equal(field in row, false);
    const restart = buildApp({ db, clock }); try { assert.equal((await post('bookings', value.body, key, 0, restart)).statusCode, 200); } finally { await restart.close(); }
    assert.deepEqual((await events(id)).map((item) => item.id), [row.id]);
  });
  await t.test('rejected intent/selection and outbox validation failure cannot commit a booking, action, claim or audit', async () => {
    const value = await fixture(); const key = randomUUID();
    assert.equal((await post('bookings', { ...value.body, deliveryMode: 'EMAIL' }, key)).statusCode, 400);
    await assert.rejects(confirmBooking(db, invalidRequest, value.body, key, clock));
    assert.equal(await db.booking.count({ where: { proposalId: value.proposalId } }), 0); assert.equal(await db.bookingAction.count({ where: { proposalId: value.proposalId, operation: 'CONFIRM' } }), 0);
    assert.equal(await db.availabilitySlot.count({ where: { id: { in: value.parts.map((row) => row.id) }, state: 'RESERVED' } }), 0); assert.equal(await db.auditEvent.count({ where: { businessId: a.id, traceId: ' ' } }), 0);
    const response = await post('bookings', value.body, key); assert.equal(response.statusCode, 201); assert.equal((await events(response.json().id)).length, 1);
  });
  await t.test('customer/OWNER cancellation races, different-key no-ops and historical confirmation replay never duplicate events', async () => {
    const value = await book(); const key = randomUUID();
    const results = await Promise.all([post(`bookings/${value.booking.id}/cancel`, {}, key), app.inject({ method: 'POST', url: `/api/v1/admin/bookings/${value.booking.id}/cancel`, headers: { ...headers, cookie: ownerCookie, 'idempotency-key': randomUUID() }, payload: {} })]); assert.ok(results.every((row) => row.statusCode === 200), results.map((row) => row.body).join('\n'));
    assert.equal((await post(`bookings/${value.booking.id}/cancel`, {}, key)).statusCode, 200); assert.equal((await post(`bookings/${value.booking.id}/cancel`, {})).statusCode, 200); assert.equal((await post('bookings', value.body, value.key)).statusCode, 200);
    assert.deepEqual((await events(value.booking.id)).map((row) => row.eventType).sort(), ['BOOKING_CANCELLED', 'BOOKING_CONFIRMED']);
    assert.equal((await post(`bookings/${value.booking.id}/cancel`, {}, randomUUID(), 1)).statusCode, 404);
  });
  await t.test('cancellation enqueue rejection rolls back the release, and a fresh retry succeeds', async () => {
    const value = await book(); const key = randomUUID();
    await assert.rejects(cancelBooking(db, invalidRequest, value.booking.id, key, clock)); assert.equal((await db.booking.findUniqueOrThrow({ where: { id: value.booking.id } })).status, 'CONFIRMED');
    assert.equal(await db.bookingSlot.count({ where: { bookingId: value.booking.id, releasedAt: null } }), 2); assert.equal((await events(value.booking.id)).length, 1);
    assert.equal((await post(`bookings/${value.booking.id}/cancel`, {}, key)).statusCode, 200); assert.equal((await events(value.booking.id)).length, 2);
  });
  await t.test('rescheduling produces one replacement event, with no separate cancellation/confirmation for that effect', async () => {
    const value = await book(); const proposalId = await moveProposal(value.booking.id, value.parts[1]!.id); const key = randomUUID();
    await assert.rejects(rescheduleBooking(db, invalidRequest, value.booking.id, proposalId, key, clock)); assert.equal((await db.booking.findUniqueOrThrow({ where: { id: value.booking.id } })).status, 'CONFIRMED'); assert.equal((await events(value.booking.id)).length, 1);
    const results = await Promise.all([post(`bookings/${value.booking.id}/reschedule`, { proposalId }, key), post(`bookings/${value.booking.id}/reschedule`, { proposalId }, key, 0, other)]); assert.ok(results.every((row) => row.statusCode === 200));
    const nextId = results[0]!.json().id as string; const rows = await events(nextId); assert.equal(rows.length, 1); assert.equal(rows[0]!.eventType, 'BOOKING_RESCHEDULED'); assert.equal(rows[0]!.previousBookingId, value.booking.id); assert.equal((await events(value.booking.id)).length, 1);
    assert.equal((await post(`bookings/${value.booking.id}/reschedule`, { proposalId })).statusCode, 409); assert.equal((await events(nextId)).length, 1);
  });
  await t.test('publisher bounds broker failures to five attempts and concurrent publishers do not share live claims', async () => {
    const value = await book(); let reference = +now;
    const failures = { publish: async () => { throw new PublishFailure('BROKER_NACK'); } };
    for (let attempt = 0; attempt < 5; attempt++) {
      await publishOutboxBatch(db, failures, { businessId: a.id, limit: 100, clock: () => new Date(reference) });
      reference += 60_000;
    }
    const [dead] = await events(value.booking.id); assert.ok(dead);
    assert.equal(dead.status, 'DEAD'); assert.equal(dead.attempts, 5); assert.equal(dead.lastErrorCode, 'BROKER_NACK');
    await book(); const seen: string[] = [];
    const confirmed = { publish: async (event: { eventId: string }) => { seen.push(event.eventId); } };
    await Promise.all([publishOutboxBatch(db, confirmed, { businessId: a.id, limit: 100, clock }), publishOutboxBatch(db, confirmed, { businessId: a.id, limit: 100, clock })]);
    assert.ok(seen.length > 0); assert.equal(new Set(seen).size, seen.length);
  });
  await t.test('expired leases recover with stable IDs; stale completion and final crashed attempts cannot overwrite history', async () => {
    await publishOutboxBatch(db, { publish: async () => {} }, { businessId: a.id, limit: 100, clock });
    const value = await book(); let reference = +now; const leaseClock = () => new Date(reference);
    const first = await claimNextEvent(db, { businessId: a.id, clock: leaseClock }); assert.equal(first?.kind, 'claimed');
    if (first?.kind !== 'claimed') throw new Error('Missing claim');
    assert.equal(first.claim.event.bookingId, value.booking.id);
    assert.equal(await claimNextEvent(db, { businessId: a.id, clock: leaseClock }), null);
    reference += 30_000;
    const recovered = await claimNextEvent(db, { businessId: a.id, clock: leaseClock }); assert.equal(recovered?.kind, 'claimed');
    if (recovered?.kind !== 'claimed') throw new Error('Missing recovered claim');
    assert.equal(recovered.claim.event.eventId, first.claim.event.eventId); assert.notEqual(recovered.claim.leaseToken, first.claim.leaseToken);
    assert.equal(await finishEventLease(db, first.claim, null, leaseClock), 'lost');
    assert.equal(await finishEventLease(db, recovered.claim, null, leaseClock), 'published');
    const final = await book();
    for (let attempt = 1; attempt <= 5; attempt++) {
      assert.equal((await claimNextEvent(db, { businessId: a.id, clock: leaseClock }))?.kind, 'claimed'); reference += 30_000;
    }
    assert.equal((await claimNextEvent(db, { businessId: a.id, clock: leaseClock }))?.kind, 'dead');
    const [row] = await events(final.booking.id); assert.ok(row); assert.equal(row.attempts, 5); assert.equal(row.lastErrorCode, 'ATTEMPTS_EXHAUSTED');
  });
  await t.test('poison messages persist only immutable fingerprints and fixed codes before acknowledgement', async () => {
    const body = Buffer.from(`synthetic-private-${tag}@example.test`);
    const message = { content: body, properties: { messageId: tag, contentType: 'application/json' }, fields: { messageCount: 0, deliveryTag: 1, redelivered: false, exchange: '', routingKey: MOCK_NOTIFICATION_QUEUE } } as GetMessage;
    const fingerprint = createHash('sha256').update('INVALID_NOTIFICATION').update('\0').update(tag).update('\0').update(body).digest('hex');
    try {
      assert.equal((await handleNotificationDelivery(db, message)).outcome, 'QUARANTINED');
      await handleNotificationDelivery(db, message);
      const added = await db.mockNotificationRejection.findMany({ where: { fingerprint } });
      assert.equal(added.length, 1); assert.equal(added[0]!.reason, 'INVALID_NOTIFICATION');
      assert.equal(JSON.stringify(added).includes(body.toString()), false);
      await assert.rejects(db.mockNotificationRejection.update({ where: { fingerprint: added[0]!.fingerprint }, data: { reason: 'PROCESSING_EXHAUSTED' } }));
    } finally { await db.mockNotificationRejection.deleteMany({ where: { fingerprint } }); }
  });
  await t.test('repeated processing failures quarantine at the broker delivery bound; unavailable quarantine never acknowledges', async () => {
    const value = await book(); await publishOutboxBatch(db, { publish: async () => {} }, { businessId: a.id, limit: 100, clock });
    const [row] = await events(value.booking.id); assert.ok(row); const body = Buffer.from(JSON.stringify(eventFromRow(row)));
    const message = { content: body, properties: { messageId: row.id, contentType: 'application/json', headers: { 'x-delivery-count': 3 } }, fields: { messageCount: 0, deliveryTag: 1, redelivered: false, exchange: '', routingKey: MOCK_NOTIFICATION_QUEUE } } as unknown as GetMessage;
    const failing = new Proxy(db, { get(target, property) { if (property === '$transaction') return async () => { throw new Error('Synthetic processing failure'); }; return Reflect.get(target, property); } });
    const fingerprint = createHash('sha256').update('PROCESSING_EXHAUSTED').update('\0').update(row.id).update('\0').update(body).digest('hex');
    try {
      await assert.rejects(handleNotificationDelivery(failing, message));
      assert.equal(await db.mockNotificationRejection.count({ where: { fingerprint } }), 0);
      message.properties.headers!['x-delivery-count'] = 4;
      assert.equal((await handleNotificationDelivery(failing, message)).outcome, 'QUARANTINED');
      assert.equal((await db.mockNotificationRejection.findUniqueOrThrow({ where: { fingerprint } })).reason, 'PROCESSING_EXHAUSTED');
      const unavailable = new Proxy(failing, { get(target, property) { if (property === 'mockNotificationRejection') return { createMany: async () => { throw new Error('Synthetic database outage'); } }; return Reflect.get(target, property); } });
      await assert.rejects(handleNotificationDelivery(unavailable, message));
      assert.equal(await db.mockNotificationReceipt.count({ where: { eventId: row.id } }), 0);
    } finally { await db.mockNotificationRejection.deleteMany({ where: { fingerprint } }); }
  });
  await t.test('trusted policy changes are scoped, audited and idempotent under concurrent retries', async () => {
    const results = await Promise.all([setMockReminderPolicy(db, a.id, true), setMockReminderPolicy(db, a.id, true)]);
    assert.equal(results.filter((r) => r.changed).length, 1);
    assert.equal(await db.auditEvent.count({ where: { businessId: a.id, eventType: 'MOCK_REMINDER_POLICY_CHANGED' } }), 1);
    assert.equal((await db.business.findUniqueOrThrow({ where: { id: ids[1]! } })).mockRemindersEnabled, false);
    assert.equal((await setMockReminderPolicy(db, a.id, false)).changed, true);
    assert.equal((await setMockReminderPolicy(db, a.id, false)).changed, false);
    await assert.rejects(setMockReminderPolicy(db, randomUUID(), true));
  });
  await t.test('reminders require persisted opt-in, respect exact 24-hour UTC bounds and concurrent scans enqueue once', async () => {
    const value = await book(); const start = +value.parts[0]!.startAt; const due = new Date(start - 86_400_000);
    const query = { businessId: a.id, clock: () => due };
    assert.equal((await scheduleMockReminders(db, query)).enqueued, 0);
    const [confirmation] = await events(value.booking.id); assert.ok(confirmation);
    const reminderData = { ...confirmation, id: randomUUID(), eventType: 'BOOKING_REMINDER' as const, occurredAt: due, createdAt: due, availableAt: due };
    await assert.rejects(db.notificationOutbox.create({ data: reminderData }));
    await db.business.update({ where: { id: a.id }, data: { mockRemindersEnabled: true } });
    await assert.rejects(db.notificationOutbox.create({ data: { ...reminderData, occurredAt: new Date(+due - 1), availableAt: new Date(+due - 1) } }));
    await scheduleMockReminders(db, { ...query, clock: () => new Date(+due - 1) });
    assert.equal((await events(value.booking.id)).filter((row) => row.eventType === 'BOOKING_REMINDER').length, 0);
    const results = await Promise.all([scheduleMockReminders(db, query), scheduleMockReminders(db, query)]);
    assert.equal(results.reduce((sum, result) => sum + result.enqueued, 0), 1);
    assert.equal((await scheduleMockReminders(db, query)).enqueued, 0);
    assert.equal((await scheduleMockReminders(db, { businessId: ids[1]!, clock: () => due })).enqueued, 0);
    const reminder = (await events(value.booking.id)).find((row) => row.eventType === 'BOOKING_REMINDER'); assert.ok(reminder);
    await publishOutboxBatch(db, { publish: async () => {} }, { businessId: a.id, limit: 100, clock: () => due });
    const result = await processMockNotification(db, eventFromRow(reminder), () => due);
    assert.equal(result.outcome, 'MOCK_DELIVERED');
    assert.equal((await processMockNotification(db, eventFromRow(reminder), () => new Date(start))).duplicate, true);
  });
  await t.test('queued reminders suppress after opt-out, cancellation, rescheduling or appointment start', async () => {
    for (const change of ['opt-out', 'cancel', 'reschedule', 'started'] as const) {
      const value = await book(); const start = +value.parts[0]!.startAt; const due = new Date(start - 86_400_000);
      await db.business.update({ where: { id: a.id }, data: { mockRemindersEnabled: true } });
      await scheduleMockReminders(db, { businessId: a.id, clock: () => due });
      const reminder = (await events(value.booking.id)).find((row) => row.eventType === 'BOOKING_REMINDER'); assert.ok(reminder);
      await publishOutboxBatch(db, { publish: async () => {} }, { businessId: a.id, limit: 100, clock: () => due });
      if (change === 'opt-out') await db.business.update({ where: { id: a.id }, data: { mockRemindersEnabled: false } });
      if (change === 'cancel') assert.equal((await post(`bookings/${value.booking.id}/cancel`, {})).statusCode, 200);
      if (change === 'reschedule') {
        const proposalId = await moveProposal(value.booking.id, value.parts[1]!.id);
        const moved = await post(`bookings/${value.booking.id}/reschedule`, { proposalId }); assert.equal(moved.statusCode, 200);
        const fresh = new Date(+due + 30 * 60_000);
        await scheduleMockReminders(db, { businessId: a.id, clock: () => fresh });
        assert.equal((await events(moved.json().id)).filter((row) => row.eventType === 'BOOKING_REMINDER').length, 1);
      }
      const result = await processMockNotification(db, eventFromRow(reminder), () => change === 'started' ? new Date(start) : due);
      assert.equal(result.outcome, 'SUPPRESSED'); assert.equal(result.reason, change === 'opt-out' ? 'REMINDERS_DISABLED' : 'STALE_BOOKING');
    }
    await db.business.update({ where: { id: a.id }, data: { mockRemindersEnabled: false } });
  });
  await t.test('reminder scan racing cancellation never delivers a cancelled booking; invalid batch bounds reject', async () => {
    const value = await book(); const due = new Date(+value.parts[0]!.startAt - 86_400_000);
    await db.business.update({ where: { id: a.id }, data: { mockRemindersEnabled: true } });
    await Promise.all([scheduleMockReminders(db, { businessId: a.id, clock: () => due }), post(`bookings/${value.booking.id}/cancel`, {})]);
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: value.booking.id } })).status, 'CANCELLED');
    await publishOutboxBatch(db, { publish: async () => {} }, { businessId: a.id, limit: 100, clock: () => due });
    const reminder = (await events(value.booking.id)).find((row) => row.eventType === 'BOOKING_REMINDER');
    if (reminder) assert.equal((await processMockNotification(db, eventFromRow(reminder), () => due)).outcome, 'SUPPRESSED');
    await assert.rejects(scheduleMockReminders(db, { limit: 101 })); await assert.rejects(scheduleMockReminders(db, { limit: 0 }));
    await db.business.update({ where: { id: a.id }, data: { mockRemindersEnabled: false } });
  });
  await t.test('worker verifies tenant/event identity and persists one mock effect across concurrent delivery and restart', async () => {
    const value = await book(); const [row] = await events(value.booking.id); assert.ok(row);
    await assert.rejects(processMockNotification(db, eventFromRow(row)), InvalidNotification);
    const published = await publishOutboxBatch(db, { publish: async () => {} }, { businessId: a.id, limit: 100, clock });
    assert.ok(published.published > 0);
    const event = eventFromRow(row);
    for (const forged of [{ ...event, businessId: ids[1] }, { ...event, bookingId: randomUUID() }, { ...event, traceId: 'forged' }, { ...event, deliveryMode: 'EMAIL' }, { ...event, message: 'untrusted' }]) {
      await assert.rejects(processMockNotification(db, forged), InvalidNotification);
    }
    const results = await Promise.all([processMockNotification(db, event), processMockNotification(db, event)]);
    assert.deepEqual(results.map((r) => r.duplicate).sort(), [false, true]);
    assert.ok(results.every((r) => r.outcome === 'MOCK_DELIVERED'));
    const restarted = createDatabaseClient(url);
    try { assert.equal((await processMockNotification(restarted, event)).duplicate, true); } finally { await restarted.$disconnect(); }
    assert.equal(await db.mockNotificationReceipt.count({ where: { eventId: row.id } }), 1);
    await assert.rejects(db.mockNotificationReceipt.update({ where: { eventId: row.id }, data: { reason: 'STALE_BOOKING', outcome: 'SUPPRESSED' } }));
  });
  await t.test('worker suppresses outdated confirmation and records current cancellation without touching booking state', async () => {
    const value = await book();
    assert.equal((await post(`bookings/${value.booking.id}/cancel`, {})).statusCode, 200);
    await publishOutboxBatch(db, { publish: async () => {} }, { businessId: a.id, limit: 100, clock });
    for (const row of await events(value.booking.id)) {
      const result = await processMockNotification(db, eventFromRow(row));
      assert.equal(result.outcome, row.eventType === 'BOOKING_CONFIRMED' ? 'SUPPRESSED' : 'MOCK_DELIVERED');
    }
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: value.booking.id } })).status, 'CANCELLED');
    assert.equal(await db.bookingSlot.count({ where: { bookingId: value.booking.id, releasedAt: null } }), 0);
  });
  await t.test('worker suppresses inactive-business events; rescheduling verifies linked persisted history', async () => {
    const value = await book(1);
    await publishOutboxBatch(db, { publish: async () => {} }, { businessId: ids[1]!, limit: 100, clock });
    await db.business.update({ where: { id: ids[1]! }, data: { active: false } });
    const [row] = await events(value.booking.id); assert.ok(row);
    assert.equal((await processMockNotification(db, eventFromRow(row))).reason, 'INACTIVE_BUSINESS');
    await db.business.update({ where: { id: ids[1]! }, data: { active: true } });
    const source = await book(); const proposalId = await moveProposal(source.booking.id, source.parts[1]!.id);
    const replacement = await post(`bookings/${source.booking.id}/reschedule`, { proposalId }); assert.equal(replacement.statusCode, 200);
    await publishOutboxBatch(db, { publish: async () => {} }, { businessId: a.id, limit: 100, clock });
    const [moved] = await events(replacement.json().id); assert.ok(moved);
    assert.equal((await processMockNotification(db, eventFromRow(moved))).outcome, 'MOCK_DELIVERED');
  });
  await t.test('real broker confirms, redelivers after connection loss and deduplicates mock delivery', { skip: !process.env.TEST_RABBITMQ_URL }, async (brokerTest) => {
    const brokerUrl = process.env.TEST_RABBITMQ_URL!;
    assert.equal(new URL(brokerUrl).pathname, '/flowpilot_test');
    const queue = `flowpilot.mock.notifications.v1.test-${randomUUID()}`;
    brokerTest.after(async () => { const cleanup = await connect(brokerUrl); try { const channel = await cleanup.createChannel(); await channel.deleteQueue(queue); } finally { await cleanup.close(); } });
    const value = await book(); const [row] = await events(value.booking.id); assert.ok(row);
    const publisher = new RabbitMqPublisher({ url: brokerUrl, queue });
    await publishOutboxBatch(db, publisher, { businessId: a.id, limit: 100, clock });
    // Scope to this known event: the queue may also contain earlier fixture events.
    const connection = await connect(brokerUrl); connection.on('error', () => {});
    try {
      const channel = await connection.createChannel();
      let message = await channel.get(queue, { noAck: false });
      while (message && message.properties.messageId !== row.id) { channel.ack(message); message = await channel.get(queue, { noAck: false }); }
      assert.ok(message); assert.equal(message.properties.deliveryMode, 2);
      const event: unknown = JSON.parse(message.content.toString());
      assert.equal((await processMockNotification(db, event)).duplicate, false);
      // Crash window: receipt committed but acknowledgement was lost.
      await channel.close();
      const restarted = await connection.createChannel();
      const again = await restarted.get(queue, { noAck: false }); assert.ok(again); assert.equal(again.fields.redelivered, true);
      assert.ok(Number(again.properties.headers?.['x-delivery-count']) >= 1);
      assert.equal((await processMockNotification(db, JSON.parse(again.content.toString()))).duplicate, true);
      restarted.ack(again);
      assert.equal(await db.mockNotificationReceipt.count({ where: { eventId: row.id } }), 1);
    } finally { const cleanup = await connection.createChannel(); await cleanup.deleteQueue(queue); await connection.close(); }
    // Exercise the actual separate worker command against the test vhost.
    const cliBooking = await book();
    await publishOutboxBatch(db, { publish: async () => {} }, { businessId: a.id, limit: 100, clock });
    const [cliEvent] = await events(cliBooking.booking.id); assert.ok(cliEvent);
    const check = await connect(brokerUrl);
    try {
      const channel = await check.createConfirmChannel();
      const state = await channel.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
      assert.equal(state.messageCount, 0, 'The dedicated test vhost must have no other queued messages.');
      assert.equal(state.consumerCount, 0);
      const poison = Buffer.from(`private-synthetic-${tag}`);
      const fingerprint = createHash('sha256').update('INVALID_NOTIFICATION').update('\0').update(tag).update('\0').update(poison).digest('hex');
      try {
        channel.sendToQueue(queue, poison, { persistent: true, contentType: 'application/json', messageId: tag });
        await channel.waitForConfirms();
        const rejected = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./worker.ts', import.meta.url)), '--once'], {
          env: { ...process.env, DATABASE_URL: url!, RABBITMQ_URL: brokerUrl, TEST_NOTIFICATION_QUEUE: queue, NOTIFICATION_WORKER_ENABLED: 'true' }, timeout: 15_000,
        });
        assert.match(rejected.stdout, /"outcome":"QUARANTINED"/); assert.equal(rejected.stdout.includes(poison.toString()), false);
        assert.equal((await db.mockNotificationRejection.findUniqueOrThrow({ where: { fingerprint } })).reason, 'INVALID_NOTIFICATION');
      } finally { await db.mockNotificationRejection.deleteMany({ where: { fingerprint } }); }
    } finally { await check.close(); }
    await new RabbitMqPublisher({ url: brokerUrl, queue }).publish(eventFromRow(cliEvent));
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./worker.ts', import.meta.url)), '--once'], {
      env: { ...process.env, DATABASE_URL: url!, RABBITMQ_URL: brokerUrl, TEST_NOTIFICATION_QUEUE: queue, NOTIFICATION_WORKER_ENABLED: 'true' }, timeout: 15_000,
    });
    assert.match(result.stdout, /"outcome":"MOCK_DELIVERED"/);
    assert.equal((await db.mockNotificationReceipt.findUniqueOrThrow({ where: { eventId: cliEvent.id } })).outcome, 'MOCK_DELIVERED');
    const unavailable = new URL(brokerUrl); unavailable.port = '1';
    await assert.rejects(new RabbitMqPublisher({ url: unavailable.href, timeoutMs: 200 }).publish(eventFromRow(cliEvent)),
      (error: unknown) => error instanceof PublishFailure && ['BROKER_UNAVAILABLE', 'BROKER_TIMEOUT'].includes(error.code));
  });
  await t.test('database enforces event uniqueness/ownership, immutable identity, mock policy and publisher-state bounds', async () => {
    const value = await book(); const foreign = await book(1); const [row] = await events(value.booking.id); assert.ok(row);
    await assert.rejects(db.notificationOutbox.create({ data: { ...row, id: randomUUID() } }), (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
    for (const patch of [{ businessId: ids[1]!, bookingId: value.booking.id }, { bookingId: foreign.booking.id }, { deliveryMode: 'EMAIL' }, { schemaVersion: 2 }, { eventType: 'BOOKING_CANCELLED' as const }, { traceId: 'raw customer text' }, { status: 'PUBLISHED' as const }]) await assert.rejects(db.notificationOutbox.create({ data: { ...row, id: randomUUID(), ...patch } }));
    for (const patch of [{ traceId: 'different-trace' }, { bookingId: foreign.booking.id }, { attempts: -1 }, { attempts: 6 }, { leaseToken: randomUUID() }, { lastErrorCode: 'customer@example.test' }, { status: 'PUBLISHED' as const }]) await assert.rejects(db.notificationOutbox.update({ where: { id: row.id }, data: patch }));
    // Validate future state contract only; there is no publisher or delivery.
    await db.notificationOutbox.update({ where: { id: row.id }, data: { attempts: 1, status: 'PUBLISHED', publishedAt: now } });
    await assert.rejects(db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'PENDING', publishedAt: null } }));
    assert.equal(await db.notificationOutbox.count({ where: { businessId: ids[1]!, bookingId: value.booking.id } }), 0);
  });
});
