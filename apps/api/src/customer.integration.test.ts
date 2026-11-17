import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDatabaseClient, localBusinessInstant } from '@flowpilot/db';
import { CustomerSessionResponseSchema, CustomerAvailabilityResponseSchema } from '@flowpilot/contracts';
import { buildApp } from './app.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Use the dedicated local flowpilot_test database.');
}
const origin = 'http://127.0.0.1:5173';
const cookieName = 'flowpilot_customer_session';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('Phase 2 customer sessions and duration-aware availability', async (t) => {
  const db = createDatabaseClient(url);
  const tag = randomUUID();
  let now = new Date('2030-01-07T22:00:00Z'); // 08:00 Brisbane, 8 January.
  const app = buildApp({ db, demoAuthEnabled: true, clock: () => new Date(now) });
  const businesses = await Promise.all(['a', 'b'].map((suffix) => db.business.create({ data: {
    slug: 'customer-' + tag + suffix, name: 'Synthetic ' + suffix, timezone: 'Australia/Brisbane',
  } })));
  const a = businesses[0]!;
  const b = businesses[1]!;
  const ids = businesses.map((business) => business.id);
  t.after(async () => {
    await app.close();
    try {
      await db.customerSession.deleteMany({ where: { businessId: { in: ids } } });
      await db.availabilitySlot.deleteMany({ where: { businessId: { in: ids } } });
      await db.service.deleteMany({ where: { businessId: { in: ids } } });
      await db.staff.deleteMany({ where: { businessId: { in: ids } } });
      await db.business.deleteMany({ where: { id: { in: ids } } });
    } finally { await db.$disconnect(); }
  });
  const staff = await Promise.all([
    { businessId: a.id, slug: 'alex', displayName: 'Alex' },
    { businessId: a.id, slug: 'jamie', displayName: 'Jamie' },
    { businessId: a.id, slug: 'inactive', displayName: 'Inactive', active: false },
    { businessId: b.id, slug: 'foreign', displayName: 'Foreign' },
  ].map((data) => db.staff.create({ data })));
  const services = await Promise.all([
    { businessId: a.id, slug: 'haircut', name: 'Haircut' },
    { businessId: a.id, slug: 'consultation', name: 'Consultation' },
    { businessId: a.id, slug: 'inactive', name: 'Inactive', active: false },
    { businessId: b.id, slug: 'foreign', name: 'Foreign' },
  ].map((data) => db.service.create({ data })));
  // Alex: 9-12 and 13-15. Jamie: 9-10, gap, then 10:30-11:30.
  for (let index = 0; index < staff.length; index++) {
    const minutes = index === 0 ? [540, 570, 600, 630, 660, 690, 780, 810, 840, 870]
      : index === 1 ? [540, 570, 630, 660] : [540, 570, 600, 630];
    await db.availabilitySlot.createMany({ data: minutes.map((minute) => {
      const startAt = localBusinessInstant('2030-01-08', 'Australia/Brisbane', Math.floor(minute / 60), minute % 60);
      return { businessId: staff[index]!.businessId, staffId: staff[index]!.id, startAt, endAt: new Date(+startAt + 1800000) };
    }) });
  }
  const bootstrap = (slug: string, cookie?: string) => app.inject({ method: 'POST', url: '/api/v1/customer/sessions',
    headers: { origin, 'x-flowpilot-client': 'web', ...(cookie ? { cookie } : {}) }, payload: { businessSlug: slug } });
  const get = (path: string, cookie?: string) => app.inject({ method: 'GET', url: '/api/v1/customer/' + path, headers: cookie ? { cookie } : {} });
  const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  let cookie = '';
  const availability = (duration = 60, extra = '', sessionCookie = cookie) =>
    get(`availability?date=2030-01-08&serviceId=${services[0]!.id}&durationMinutes=${duration}${extra}`, sessionCookie);

  await t.test('bootstrap protects origin, validates public scope and stores only a token hash', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', payload: { businessSlug: a.slug } });
    assert.equal(denied.statusCode, 403);
    assert.equal((await bootstrap('unknown-' + tag)).statusCode, 404);
    const response = await bootstrap(a.slug);
    assert.equal(response.statusCode, 201);
    cookie = cookieOf(response);
    const dto = CustomerSessionResponseSchema.parse(response.json());
    assert.equal(dto.maxBookingDurationMinutes, 120);
    assert.equal(dto.today, '2030-01-08');
    assert.equal(dto.expiresAt, '2030-01-08T06:00:00.000Z');
    assert.match(String(response.headers['set-cookie']), /HttpOnly/);
    assert.match(String(response.headers['set-cookie']), /SameSite=Strict/i);
    assert.match(String(response.headers['set-cookie']), /Path=\/api\/v1\/customer/);
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const saved = await db.customerSession.findUniqueOrThrow({ where: { tokenHash: hash(token) } });
    assert.notEqual(saved.tokenHash, token);
    assert.equal(response.body.includes(token), false);
    assert.equal(response.body.includes(saved.tokenHash), false);
    assert.equal((await get('session', cookie)).statusCode, 200);
  });

  await t.test('session rotation preserves identity and invalidates the previous secret', async () => {
    const oldCookie = cookie;
    const old = await db.customerSession.findUniqueOrThrow({ where: { tokenHash: hash(oldCookie.split('=')[1]!) } });
    const response = await bootstrap(a.slug, oldCookie);
    assert.equal(response.statusCode, 201);
    cookie = cookieOf(response);
    assert.notEqual(cookie, oldCookie);
    const saved = await db.customerSession.findUniqueOrThrow({ where: { tokenHash: hash(cookie.split('=')[1]!) } });
    assert.equal(saved.id, old.id);
    assert.equal((await get('session', oldCookie)).statusCode, 401);
    assert.equal((await get('session', cookie)).statusCode, 200);
  });

  await t.test('customer identity is separate; active catalog lists and pagination are scoped', async () => {
    assert.equal((await availability(60, '', '')).statusCode, 401);
    assert.equal((await get('session', 'flowpilot_session=' + 'a'.repeat(64))).statusCode, 401);
    assert.equal((await get('session', cookieName + '=bad')).statusCode, 401);
    const serviceList = await get('services?pageSize=1', cookie);
    assert.equal(serviceList.statusCode, 200);
    assert.equal(serviceList.json().pagination.total, 2);
    assert.equal(serviceList.json().items.length, 1);
    assert.equal((await get('services?page=2&pageSize=1', cookie)).json().items.length, 1);
    const employees = await get('staff', cookie);
    assert.equal(employees.json().pagination.total, 2);
    assert.ok(employees.json().items.every((item: { businessId: string; active: boolean }) => item.businessId === a.id && item.active));
    assert.equal((await get('staff?businessId=' + b.id, cookie)).statusCode, 400);
    assert.equal((await get('session?businessId=' + b.id, cookie)).statusCode, 400);
    const foreignCookie = cookieOf(await bootstrap(b.slug));
    const foreignList = await get('services', foreignCookie);
    assert.equal(foreignList.json().items[0].id, services[3]!.id);
    assert.equal((await availability(60, '', foreignCookie)).statusCode, 404);
  });

  await t.test('availability finds complete 30/60/90/120-minute runs with stable pagination', async () => {
    const counts = new Map([[30, 14], [60, 10], [90, 6], [120, 4]]);
    for (const [duration, total] of counts) {
      const response = await availability(duration, '&pageSize=50');
      assert.equal(response.statusCode, 200, response.body);
      const result = CustomerAvailabilityResponseSchema.parse(response.json());
      assert.equal(result.pagination.total, total);
      assert.equal(result.items.length, total);
      assert.equal(result.asOf, now.toISOString());
      assert.ok(result.items.every((item) => Date.parse(item.endAt) - Date.parse(item.startAt) === duration * 60000));
      assert.ok(result.items.every((item) => item.businessId === a.id));
      assert.ok(result.items.every((item) => item.staffId !== staff[2]!.id && item.staffId !== staff[3]!.id));
    }
    const first = (await availability(60, '&pageSize=1')).json();
    const second = (await availability(60, '&pageSize=1&page=2')).json();
    assert.equal(first.pagination.total, 10);
    assert.notEqual(first.items[0].slotId, second.items[0].slotId);
    const beyond = (await availability(60, '&pageSize=1&page=999')).json();
    assert.equal(beyond.items.length, 0);
    assert.equal(beyond.pagination.total, 10);
    const alex = (await availability(120, '&staffId=' + staff[0]!.id)).json();
    assert.equal(alex.pagination.total, 4);
    assert.ok(alex.items.every((item: { staffId: string }) => item.staffId === staff[0]!.id));
  });

  await t.test('gaps, breaks, reserved/blocked slots and elapsed starts are excluded without holds', async () => {
    const beforeSlots = await db.availabilitySlot.findMany({ where: { businessId: a.id }, orderBy: { id: 'asc' } });
    const beforeBookings = await db.booking.count({ where: { businessId: a.id } });
    const response = await availability(120, '&staffId=' + staff[0]!.id);
    assert.equal(response.json().items.some((item: { startAt: string }) => item.startAt === '2030-01-08T01:30:00.000Z'), false); // 11:30 bridges lunch.
    assert.equal((await availability(90, '&staffId=' + staff[1]!.id)).json().pagination.total, 0); // Do not combine employees or bridge Jamie's gap.
    const target = beforeSlots.find((slot) => slot.staffId === staff[0]!.id && slot.startAt.toISOString() === '2030-01-07T23:30:00.000Z')!;
    for (const state of ['RESERVED', 'BLOCKED'] as const) {
      await db.availabilitySlot.update({ where: { id: target.id }, data: { state } });
      const changed = (await availability(60, '&staffId=' + staff[0]!.id)).json();
      assert.equal(changed.items.some((item: { startAt: string }) => ['2030-01-07T23:00:00.000Z', '2030-01-07T23:30:00.000Z'].includes(item.startAt)), false);
    }
    await db.availabilitySlot.update({ where: { id: target.id }, data: { state: 'AVAILABLE' } });
    now = new Date('2030-01-08T00:00:00Z'); // 10:00: exact-now starts also excluded.
    const later = (await availability(30)).json();
    assert.ok(later.items.every((item: { startAt: string }) => Date.parse(item.startAt) > +now));
    now = new Date('2030-01-07T22:00:00Z');
    assert.deepEqual(await db.availabilitySlot.findMany({ where: { businessId: a.id }, orderBy: { id: 'asc' } }), beforeSlots);
    assert.equal(await db.booking.count({ where: { businessId: a.id } }), beforeBookings);
    assert.equal(await db.bookingProposal.count({ where: { businessId: a.id } }), 0);
    const past = await get(`availability?date=2030-01-07&serviceId=${services[0]!.id}&durationMinutes=30`, cookie);
    assert.equal(past.json().pagination.total, 0);
  });

  await t.test('limits, inactive/foreign resources and unsupported inputs fail explicitly', async () => {
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 60 } });
    const tooLong = await availability(90);
    assert.equal(tooLong.statusCode, 409);
    assert.equal(tooLong.json().code, 'DURATION_NOT_ALLOWED');
    assert.equal((await get('session', cookie)).json().maxBookingDurationMinutes, 60);
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 120 } });
    for (const serviceId of [services[2]!.id, services[3]!.id, randomUUID()]) {
      assert.equal((await get(`availability?date=2030-01-08&serviceId=${serviceId}&durationMinutes=60`, cookie)).statusCode, 404);
    }
    for (const staffId of [staff[2]!.id, staff[3]!.id, randomUUID()]) {
      assert.equal((await availability(60, '&staffId=' + staffId)).statusCode, 404);
    }
    for (const extra of ['&businessId=' + b.id, '&state=RESERVED', '&pageSize=51', '&date=2030-02-30']) {
      assert.equal((await availability(60, extra)).statusCode, 400);
    }
    assert.equal((await availability(45)).statusCode, 400);
    await db.business.update({ where: { id: a.id }, data: { active: false } });
    assert.equal((await get('session', cookie)).statusCode, 401);
    assert.equal((await bootstrap(a.slug)).statusCode, 404);
    await db.business.update({ where: { id: a.id }, data: { active: true } });
    await db.service.update({ where: { id: services[0]!.id }, data: { active: false } });
    assert.equal((await availability()).statusCode, 404);
    await db.service.update({ where: { id: services[0]!.id }, data: { active: true } });
  });

  await t.test('expiry, business switch, revoked tokens, reload and logout preserve session boundaries', async () => {
    const initialCookie = cookie;
    now = new Date('2030-01-08T06:00:00Z');
    assert.equal((await get('session', initialCookie)).statusCode, 401);
    now = new Date('2030-01-07T22:00:00Z');
    const switchResponse = await bootstrap(b.slug, cookie);
    assert.equal(switchResponse.statusCode, 201);
    const bCookie = cookieOf(switchResponse);
    assert.equal((await get('session', initialCookie)).statusCode, 401);
    assert.equal((await get('session', bCookie)).json().businessId, b.id);
    const restarted = buildApp({ db, clock: () => new Date(now) });
    try {
      const reload = await restarted.inject({ method: 'GET', url: '/api/v1/customer/session', headers: { cookie: bCookie } });
      assert.equal(reload.statusCode, 200);
    } finally { await restarted.close(); }
    const logout = await app.inject({ method: 'POST', url: '/api/v1/customer/logout', headers: { origin, 'x-flowpilot-client': 'web', cookie: bCookie } });
    assert.equal(logout.statusCode, 200);
    assert.match(String(logout.headers['set-cookie']), /Path=\/api\/v1\/customer/);
    assert.equal((await get('session', bCookie)).statusCode, 401);
    const again = await app.inject({ method: 'POST', url: '/api/v1/customer/logout', headers: { origin, 'x-flowpilot-client': 'web', cookie: bCookie } });
    assert.equal(again.statusCode, 200);
    assert.ok(await db.customerSession.count({ where: { businessId: { in: ids }, revokedAt: { not: null } } }) >= 2);
  });
});

test('customer routes apply rate limits separately from dashboard login', async (t) => {
  const db = createDatabaseClient(url);
  const app = buildApp({ db });
  t.after(async () => { await app.close(); await db.$disconnect(); });
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers: { origin, 'x-flowpilot-client': 'web' }, payload: { businessSlug: 'not-a-business' } })).statusCode, 404);
  }
  const response = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers: { origin, 'x-flowpilot-client': 'web' }, payload: { businessSlug: 'not-a-business' } });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().code, 'RATE_LIMITED');
  assert.ok(response.json().traceId);
});

test('customer local-date inventory respects 23-hour and 25-hour DST days', async (t) => {
  const db = createDatabaseClient(url);
  const tag = randomUUID();
  const business = await db.business.create({ data: { slug: 'dst-customer-' + tag, name: 'Synthetic DST', timezone: 'America/New_York' } });
  t.after(async () => {
    try {
      await db.customerSession.deleteMany({ where: { businessId: business.id } });
      await db.availabilitySlot.deleteMany({ where: { businessId: business.id } });
      await db.service.deleteMany({ where: { businessId: business.id } });
      await db.staff.deleteMany({ where: { businessId: business.id } });
      await db.business.delete({ where: { id: business.id } });
    } finally { await db.$disconnect(); }
  });
  const staff = await db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } });
  const service = await db.service.create({ data: { businessId: business.id, slug: 'service', name: 'Synthetic service' } });
  for (const [date, start, end, total] of [
    ['2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 46],
    ['2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 50],
  ] as const) {
    const referenceTime = new Date(Date.parse(start) - 3600000);
    const app = buildApp({ db, clock: () => referenceTime });
    try {
      const slots = [];
      for (let instant = Date.parse(start) - 1800000; instant <= Date.parse(end); instant += 1800000) {
        slots.push({ businessId: business.id, staffId: staff.id, startAt: new Date(instant), endAt: new Date(instant + 1800000) });
      }
      await db.availabilitySlot.createMany({ data: slots });
      const session = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers: { origin, 'x-flowpilot-client': 'web' }, payload: { businessSlug: business.slug } });
      assert.equal(session.statusCode, 201);
      const cookie = String(session.headers['set-cookie']).split(';')[0]!;
      const response = await app.inject({ method: 'GET',
        url: `/api/v1/customer/availability?date=${date}&durationMinutes=30&serviceId=${service.id}&pageSize=50`, headers: { cookie } });
      assert.equal(response.statusCode, 200, response.body);
      const result = CustomerAvailabilityResponseSchema.parse(response.json());
      assert.equal(result.pagination.total, total);
      assert.equal(result.items[0]!.startAt, new Date(start).toISOString());
      assert.equal(result.items.at(-1)!.endAt, new Date(end).toISOString());
      assert.ok(result.items.every((item) => Date.parse(item.startAt) >= Date.parse(start) && Date.parse(item.startAt) < Date.parse(end)));
    } finally { await app.close(); }
  }
});
