import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDatabaseClient, hashPassword, seedBusinessSetup, businessDayBounds, localBusinessInstant } from '@flowpilot/db';
import { buildApp } from './app.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Use the dedicated local flowpilot_test database.');
}
test('Booking Phase 1 business setup', async (t) => {
  const db = createDatabaseClient(url);
  const tag = randomUUID();
  const password = 'synthetic-test-password';
  const passwordHash = await hashPassword(password);
  const businessA = await db.business.create({ data: { slug: 'test-' + tag + '-a', name: 'Business A', timezone: 'Australia/Brisbane' } });
  const businessB = await db.business.create({ data: { slug: 'test-' + tag + '-b', name: 'Hidden business B', timezone: 'America/New_York' } });
  const users = await Promise.all(['CLIENT', 'CLIENT', 'ADMIN', 'ADMIN'].map((role, index) =>
    db.user.create({ data: { email: 'booking-' + tag + '-' + index + '@flowpilot.test', role: role as 'CLIENT' | 'ADMIN', passwordHash } })));
  const membershipA = await db.businessMembership.create({ data: { userId: users[0]!.id, businessId: businessA.id, role: 'OWNER' } });
  await db.businessMembership.create({ data: { userId: users[1]!.id, businessId: businessA.id, role: 'STAFF' } });
  await db.businessMembership.create({ data: { userId: users[2]!.id, businessId: businessB.id, role: 'OWNER' } });
  const staffA = await db.staff.create({ data: { businessId: businessA.id, slug: 'alex', displayName: 'Alex A' } });
  const staffA2 = await db.staff.create({ data: { businessId: businessA.id, slug: 'jamie', displayName: 'Jamie A' } });
  const staffB = await db.staff.create({ data: { businessId: businessB.id, slug: 'hidden', displayName: 'Hidden staff B' } });
  await db.service.createMany({ data: [
    { businessId: businessA.id, slug: 'haircut', name: 'Haircut A' },
    { businessId: businessA.id, slug: 'consultation', name: 'Consultation A', active: false },
    { businessId: businessB.id, slug: 'hidden', name: 'Hidden service B' },
  ] });
  const start = localBusinessInstant('2026-11-16', 'Australia/Brisbane', 9);
  await db.availabilitySlot.createMany({ data: [
    { businessId: businessA.id, staffId: staffA.id, startAt: start, endAt: new Date(+start + 1800000) },
    { businessId: businessA.id, staffId: staffA.id, startAt: new Date(+start + 1800000), endAt: new Date(+start + 3600000), state: 'BLOCKED' },
    { businessId: businessA.id, staffId: staffA2.id, startAt: start, endAt: new Date(+start + 1800000) },
    { businessId: businessB.id, staffId: staffB.id, startAt: start, endAt: new Date(+start + 1800000) },
  ] });
  const origin = 'http://127.0.0.1:5173';
  const app = buildApp({ db, demoAuthEnabled: true, clock: () => new Date('2026-11-15T15:00:00Z') });
  t.after(async () => {
    await app.close();
    const businessIds = [businessA.id, businessB.id];
    await db.auditEvent.deleteMany({ where: { businessId: { in: businessIds } } });
    await db.availabilitySlot.deleteMany({ where: { businessId: { in: businessIds } } });
    await db.service.deleteMany({ where: { businessId: { in: businessIds } } });
    await db.staff.deleteMany({ where: { businessId: { in: businessIds } } });
    await db.businessMembership.deleteMany({ where: { businessId: { in: businessIds } } });
    await db.business.deleteMany({ where: { id: { in: businessIds } } });
    await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    await db.$disconnect();
  });
  const cookies: string[] = [];
  for (const user of users) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      headers: { origin, 'x-flowpilot-client': 'web' }, payload: { email: user.email, password } });
    assert.equal(response.statusCode, 200);
    cookies.push(String(response.headers['set-cookie']).split(';')[0]!);
  }
  const get = (path: string, index = 0) => app.inject({ method: 'GET', url: '/api/v1/admin' + path, headers: { cookie: cookies[index]! } });

  await t.test('only an active membership grants business access, not legacy ADMIN', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/business' })).statusCode, 401);
    assert.equal((await get('/business', 3)).statusCode, 403);
    const response = await get('/business');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().business.id, businessA.id);
    assert.equal(response.json().membership.role, 'OWNER');
    assert.equal(response.json().today, '2026-11-16');
    assert.equal((await get('/business', 1)).json().membership.role, 'STAFF');
    assert.equal((await get('/business', 2)).json().business.id, businessB.id);
    await db.businessMembership.update({ where: { id: membershipA.id }, data: { active: false } });
    assert.equal((await get('/staff')).statusCode, 403);
    await db.businessMembership.update({ where: { id: membershipA.id }, data: { active: true } });
    await db.business.update({ where: { id: businessA.id }, data: { active: false } });
    assert.equal((await get('/services')).statusCode, 403);
    await db.business.update({ where: { id: businessA.id }, data: { active: true } });
  });
  await t.test('staff/service lists and pagination totals never cross businesses', async () => {
    const staff = await get('/staff?pageSize=1');
    assert.equal(staff.json().items.length, 1);
    assert.equal(staff.json().pagination.total, 2);
    assert.equal(staff.json().items[0].businessId, businessA.id);
    assert.equal((await get('/staff?page=2&pageSize=1')).json().items.length, 1);
    assert.equal((await get('/services')).json().pagination.total, 2);
    assert.equal((await get('/services', 2)).json().items[0].businessId, businessB.id);
    for (const path of ['/business?businessId=' + businessB.id, '/staff?businessId=' + businessB.id, '/services?pageSize=51']) {
      assert.equal((await get(path)).statusCode, 400);
    }
  });
  await t.test('slot queries use local-day bounds, same-business filters and bounded pages', async () => {
    const slots = await get('/slots?date=2026-11-16&pageSize=2');
    assert.equal(slots.json().pagination.total, 3);
    assert.equal(slots.json().items.length, 2);
    assert.ok(slots.json().items.every((slot: { businessId: string }) => slot.businessId === businessA.id));
    assert.equal(slots.json().items[0].startAt, '2026-11-15T23:00:00.000Z');
    assert.equal((await get('/slots?date=2026-11-15')).json().pagination.total, 0);
    assert.equal((await get('/slots?date=2026-11-16&staffId=' + staffA.id)).json().pagination.total, 2);
    assert.equal((await get('/slots?date=2026-11-16&state=BLOCKED')).json().pagination.total, 1);
    assert.equal((await get('/slots?date=2026-11-16&staffId=' + staffB.id)).statusCode, 404);
    assert.equal((await get('/slots?date=2026-11-16&staffId=' + randomUUID())).statusCode, 404);
    for (const path of ['/slots', '/slots?date=2026-02-30', '/slots?date=2026-11-16&businessId=' + businessB.id, '/slots?date=2026-11-16&state=BOOKED']) {
      assert.equal((await get(path)).statusCode, 400);
    }
  });
  await t.test('database rejects cross-business staff references, duplicate slots and invalid grids/durations', async () => {
    const later = new Date(+start + 7200000);
    await assert.rejects(db.availabilitySlot.create({ data: {
      businessId: businessA.id, staffId: staffB.id, startAt: later, endAt: new Date(+later + 1800000),
    } }));
    await assert.rejects(db.availabilitySlot.create({ data: { businessId: businessA.id, staffId: staffA.id, startAt: start, endAt: new Date(+start + 1800000) } }));
    for (const [offset, duration] of [[900000, 1800000], [7200000, 3600000], [7200000, 0]]) {
      const begin = new Date(+start + offset!);
      await assert.rejects(db.availabilitySlot.create({ data: { businessId: businessA.id, staffId: staffA.id, startAt: begin, endAt: new Date(+begin + duration!) } }));
    }
    await assert.rejects(db.service.create({ data: { businessId: businessA.id, slug: 'invalid-duration', name: 'Invalid', durationMinutes: 60 } }));
  });
  await t.test('business audit events no longer require an artificial workflow', async () => {
    const event = await db.auditEvent.create({ data: { businessId: businessA.id, entityType: 'Business', entityId: businessA.id,
      actorType: 'USER', actorId: users[0]!.id, eventType: 'TEST_SETUP', traceId: tag } });
    assert.equal(event.runId, null);
    await assert.rejects(db.auditEvent.create({ data: { actorType: 'SYSTEM', eventType: 'ORPHAN', traceId: tag } }));
  });
  await t.test('Phase 1 exposes no booking or schedule mutation endpoints', async () => {
    for (const index of [0, 1]) {
      for (const path of ['/api/v1/bookings', '/api/v1/admin/services', '/api/v1/admin/slots/' + randomUUID()]) {
        const response = await app.inject({ method: 'POST', url: path, headers: { cookie: cookies[index]!, origin, 'x-flowpilot-client': 'web' }, payload: {} });
        assert.equal(response.statusCode, 404);
      }
    }
  });
  await t.test('salon seeds are repeatable and preserve reserved inventory and business setup', async () => {
    const first = await seedBusinessSetup(db, passwordHash, new Date('2026-11-16T00:00:00Z'), '2026-11-16');
    const bounds = { start: businessDayBounds('2026-11-16', 'Australia/Brisbane').start, end: businessDayBounds('2026-11-30', 'Australia/Brisbane').start };
    const where = { businessId: first.businessId, startAt: { gte: bounds.start, lt: bounds.end } };
    assert.equal(await db.staff.count({ where: { businessId: first.businessId } }), 2);
    assert.equal(await db.service.count({ where: { businessId: first.businessId } }), 2);
    assert.equal(await db.availabilitySlot.count({ where }), 280);
    const slot = await db.availabilitySlot.findFirstOrThrow({ where });
    await db.availabilitySlot.update({ where: { id: slot.id }, data: { state: 'RESERVED' } });
    const owner = await db.user.findUniqueOrThrow({ where: { email: 'owner@flowpilot.test' } });
    await seedBusinessSetup(db, 'should-not-overwrite', new Date('2026-11-16T00:00:00Z'), '2026-11-16');
    assert.equal(await db.availabilitySlot.count({ where }), 280);
    assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slot.id } })).state, 'RESERVED');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).passwordHash, owner.passwordHash);
    const person = await db.staff.findFirstOrThrow({ where: { businessId: first.businessId, slug: 'alex' } });
    const countBefore = await db.availabilitySlot.count({ where: { staffId: person.id } });
    await db.staff.update({ where: { id: person.id }, data: { active: false } });
    try {
      await seedBusinessSetup(db, passwordHash, new Date('2027-02-01T00:00:00Z'), '2027-02-01');
      assert.equal((await db.staff.findUniqueOrThrow({ where: { id: person.id } })).active, false);
      assert.equal(await db.availabilitySlot.count({ where: { staffId: person.id } }), countBefore);
    } finally { await db.staff.update({ where: { id: person.id }, data: { active: true } }); }
  });
});

