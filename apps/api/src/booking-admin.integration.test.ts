import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { createDatabaseClient, hashPassword } from '@flowpilot/db';
import { buildApp } from './app.js';
import { cancelBusinessBooking } from './booking-admin.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) throw new Error('Dedicated local test database required.');
const headers = { origin: 'http://127.0.0.1:5173', 'x-flowpilot-client': 'web' };
test('Phase 5 Step 5 scoped booking administration and redacted audits', async (t) => {
  const db = createDatabaseClient(url); const tag = randomUUID(); const clock = () => new Date('2030-01-07T22:00Z'); const app = buildApp({ db, clock, demoAuthEnabled: true }); const other = buildApp({ db, clock });
  const businesses = await Promise.all(['a','b'].map((part) => db.business.create({ data: { slug: `admin-${tag}-${part}`, name: 'Synthetic Administration' } }))); const a = businesses[0]!; const ids = businesses.map((row) => row.id);
  const password = 'synthetic-admin-password'; const passwordHash = await hashPassword(password);
  const users = await Promise.all(['CLIENT','ADMIN','CLIENT','ADMIN'].map((role,index) => db.user.create({ data: { role: role as 'CLIENT'|'ADMIN', email: `admin-${tag}-${index}@example.test`, passwordHash } })));
  for (const [i,role] of ['OWNER','STAFF','OWNER'].entries()) await db.businessMembership.create({ data: { businessId: businesses[i === 2 ? 1 : 0]!.id, userId: users[i]!.id, role: role as 'OWNER'|'STAFF' } });
  const staff = await Promise.all(businesses.map((business) => db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } })));
  const services = await Promise.all(businesses.map((business) => db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } })));
  t.after(async () => { await app.close(); await other.close(); try { await db.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany({ where: { businessId: { in: ids } } }); await tx.notificationOutbox.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingAction.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingSlot.deleteMany({ where: { businessId: { in: ids } } }); await tx.booking.deleteMany({ where: { businessId: { in: ids } } }); await tx.bookingProposal.deleteMany({ where: { businessId: { in: ids } } }); await tx.customerSession.deleteMany({ where: { businessId: { in: ids } } });
    await tx.availabilitySlot.deleteMany({ where: { businessId: { in: ids } } }); await tx.staff.deleteMany({ where: { businessId: { in: ids } } }); await tx.service.deleteMany({ where: { businessId: { in: ids } } }); await tx.businessMembership.deleteMany({ where: { businessId: { in: ids } } }); await tx.business.deleteMany({ where: { id: { in: ids } } }); await tx.user.deleteMany({ where: { id: { in: users.map((row) => row.id) } } });
  }); } finally { await db.$disconnect(); } });
  const cookies: string[] = [];
  for (const user of users) { const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: user.email, password } }); assert.equal(response.statusCode,200); cookies.push(String(response.headers['set-cookie']).split(';')[0]!); }
  let ip = 1; let offset = 0;
  const get = (path: string, actor = 0) => app.inject({ method: 'GET', url: '/api/v1/admin/' + path, headers: { cookie: cookies[actor]! } });
  const cancel = (id: string, key: string = randomUUID(), actor = 0, server = app) => server.inject({ method: 'POST', url: `/api/v1/admin/bookings/${id}/cancel`, remoteAddress: `127.0.9.${ip++}`, headers: { ...headers, cookie: cookies[actor]!, 'idempotency-key': key }, payload: {} });
  const book = async (index = 0, name = 'Synthetic') => {
    const startAt = new Date(Date.parse('2030-01-07T23:00Z') + offset++ * 86400000); const parts = [];
    for (let n = 0; n < 2; n++) parts.push(await db.availabilitySlot.create({ data: { businessId: businesses[index]!.id, staffId: staff[index]!.id, startAt: new Date(+startAt + n * 1800000), endAt: new Date(+startAt + (n + 1) * 1800000) } }));
    const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/customer/sessions', headers, payload: { businessSlug: businesses[index]!.slug } }); const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
    const selection = await app.inject({ method: 'POST', url: '/api/v1/customer/booking-proposals', headers: { ...headers, cookie, 'idempotency-key': randomUUID() }, payload: { slotId: parts[0]!.id, serviceId: services[index]!.id, durationMinutes: 60 } }); assert.equal(selection.statusCode,201);
    const response = await app.inject({ method: 'POST', url: '/api/v1/customer/bookings', headers: { ...headers, cookie, 'idempotency-key': randomUUID() }, payload: { proposalId: selection.json().id, customer: { name, email: 'demo@example.test' } } }); assert.equal(response.statusCode,201); return response.json() as { id: string };
  };
  const first = await book(); const second = await book(0, 'Synthetic 100%_\\ Customer'); const foreign = await book(1);
  await t.test('active OWNER/STAFF reads are scoped, paginated, filtered and never grant legacy global roles', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/bookings' })).statusCode,401); assert.equal((await get('bookings',3)).statusCode,403);
    for (const actor of [0,1]) { const result = await get('bookings?pageSize=1',actor); assert.equal(result.statusCode,200); assert.equal(result.json().pagination.total,2); assert.equal(result.json().items.length,1); assert.ok(result.json().items.every((row: { businessId: string }) => row.businessId === a.id)); }
    assert.equal((await get('bookings?date=2030-01-08')).json().pagination.total,1); assert.equal((await get('bookings?status=CANCELLED')).json().pagination.total,0); assert.equal((await get('bookings?staffId='+staff[1]!.id)).statusCode,404);
    assert.equal((await get('bookings/'+foreign.id)).statusCode,404); assert.equal((await get('audit-events?bookingId='+foreign.id)).statusCode,404);
    for (const path of ['bookings?businessId='+businesses[1]!.id,'audit-events?actorId='+users[0]!.id,'bookings?date=2030-02-30','audit-events?pageSize=51']) assert.equal((await get(path)).statusCode,400);
    const audit = await get('audit-events?bookingId='+first.id,1); assert.equal(audit.statusCode,200); assert.ok(audit.json().items.length > 0);
    for (const row of audit.json().items) { assert.equal('metadata' in row,false); assert.equal('actorId' in row,false); assert.equal('customerEmail' in row,false); }
  });
  await t.test('name/reference search is case-insensitive, literal, paginated and tenant-scoped', async () => {
    const reference = (await get('bookings/' + first.id)).json().reference as string;
    const foreignReference = (await get('bookings/' + foreign.id, 2)).json().reference as string;
    for (const actor of [0, 1]) {
      const names = await get('bookings?search=sYnThEtIc&pageSize=1', actor);
      assert.equal(names.statusCode, 200); assert.equal(names.json().pagination.total, 2); assert.equal(names.json().items.length, 1);
      assert.equal((await get('bookings?search=' + encodeURIComponent(reference.toLowerCase()), actor)).json().items[0].id, first.id);
      assert.equal((await get('bookings?search=' + encodeURIComponent(foreignReference), actor)).json().pagination.total, 0);
      for (const literal of ['%', '_', '\\']) {
        const result = await get('bookings?search=' + encodeURIComponent(literal), actor);
        assert.equal(result.statusCode, 200); assert.equal(result.json().pagination.total, 1); assert.equal(result.json().items[0].id, second.id);
      }
    }
    assert.equal((await get('bookings?search=Synthetic&date=2030-01-08&status=CONFIRMED&staffId=' + staff[0]!.id)).json().pagination.total, 1);
    assert.equal((await get('bookings?search=Synthetic&status=CANCELLED')).json().pagination.total, 0);
    assert.equal((await get('bookings?search=unknown')).json().pagination.total, 0);
    for (const search of [' ', 'x'.repeat(101)]) assert.equal((await get('bookings?search=' + encodeURIComponent(search))).statusCode, 400);
  });
  await t.test('only OWNER can explicitly cancel same-business future appointments with atomic minimal audited retries', async () => {
    assert.equal((await cancel(first.id,randomUUID(),1)).statusCode,403); assert.equal((await cancel(first.id,randomUUID(),2)).statusCode,404); assert.equal((await cancel(first.id,randomUUID(),3)).statusCode,403);
    const key = randomUUID(); const results = await Promise.all([cancel(first.id,key),cancel(first.id,key,0,other)]); assert.ok(results.every((row) => row.statusCode===200)); assert.deepEqual(results[0]!.json(),results[1]!.json());
    assert.equal(await db.bookingSlot.count({ where: { bookingId: first.id, releasedAt: null } }),0); assert.equal(await db.auditEvent.count({ where: { entityId: first.id,eventType:'BOOKING_CANCELLED_BY_OWNER' } }),1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: first.id,eventType:'BOOKING_CANCELLED_BY_OWNER' } }); assert.equal(audit.actorId,users[0]!.id); assert.equal(JSON.stringify(audit.metadata).includes('example.test'),false);
    assert.equal((await cancel(second.id,key)).json().code,'IDEMPOTENCY_CONFLICT'); assert.equal((await cancel(first.id)).statusCode,200);
  });
  await t.test('audit failure rolls back every release and key, then revoked access denies original replay', async () => {
    const key = randomUUID(); const bad = { cookies: { flowpilot_session: cookies[0]!.split('=')[1] }, id: undefined } as unknown as FastifyRequest;
    await assert.rejects(cancelBusinessBooking(db,bad,second.id,key,clock)); assert.equal((await get('bookings/'+second.id)).json().status,'CONFIRMED'); assert.equal(await db.bookingSlot.count({ where: { bookingId: second.id,releasedAt:null } }),2);
    assert.equal((await cancel(second.id,key)).statusCode,200); await db.businessMembership.updateMany({ where: { userId: users[0]!.id }, data: { active:false } }); assert.equal((await cancel(second.id,key)).statusCode,403);
  });
});
