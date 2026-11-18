import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { businessDate, createDatabaseClient } from '@flowpilot/db';
import { BookingProposalResponseSchema, BookingResponseSchema, CustomerSessionResponseSchema } from '@flowpilot/contracts';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Use the dedicated local flowpilot_test database.');
}

test('booking HTTP retries and ownership survive a real API restart without leaking customer data', { timeout: 45000 }, async () => {
  const db = createDatabaseClient(url);
  const tag = randomUUID();
  const business = await db.business.create({ data: { slug: 'http-gate-' + tag, name: 'Synthetic restart business', timezone: 'Australia/Brisbane' } });
  let child: ChildProcess | undefined;
  let logs = '';
  async function stop() {
    const running = child;
    child = undefined;
    if (running && running.exitCode === null && running.signalCode === null) {
      const exited = once(running, 'exit');
      running.kill('SIGTERM');
      await exited;
    }
  }
  try {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('Could not select an isolated test port.');
    const port = address.port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const base = `http://127.0.0.1:${port}/api/v1`;
    async function start() {
      child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_URL: url!, API_HOST: '127.0.0.1', API_PORT: String(port), NODE_ENV: 'test', DEMO_AUTH_ENABLED: 'true', WEB_ORIGIN: 'http://127.0.0.1:5173' },
      });
      const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-200000); };
      child.stdout!.on('data', capture); child.stderr!.on('data', capture);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('HTTP test API exited before ready.');
        try { if ((await fetch(base + '/health/ready', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Starting. */ }
        await delay(100);
      }
      throw new Error('HTTP test API did not become ready.');
    }
    const service = await db.service.create({ data: { businessId: business.id, slug: 'synthetic', name: 'Synthetic consultation' } });
    const staff = await db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } });
    // Future aligned inventory independent of the date the test happens to run.
    const first = Math.ceil(Date.now() / 1800000) * 1800000 + 2 * 86400000;
    const slots: { id: string }[] = [];
    for (let index = 0; index < 6; index++) slots.push(await db.availabilitySlot.create({ data: {
      businessId: business.id, staffId: staff.id, startAt: new Date(first + index * 1800000), endAt: new Date(first + (index + 1) * 1800000),
    } }));
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Flowpilot-Client': 'web', 'Content-Type': 'application/json' };
    await start();
    const bootstrap = await fetch(base + '/customer/sessions', { method: 'POST', headers, body: JSON.stringify({ businessSlug: business.slug }) });
    assert.equal(bootstrap.status, 201);
    CustomerSessionResponseSchema.parse(await bootstrap.json());
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    const chatMessage = 'Private synthetic chat ' + tag;
    const chat = await fetch(base + '/customer/chat/messages', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({
      message: chatMessage, context: { serviceId: null, staffId: null, date: null, durationMinutes: null },
    }) });
    assert.equal(chat.status, 200);
    const proposalResult = await fetch(base + '/customer/booking-proposals', { method: 'POST', headers: { ...headers, cookie, 'Idempotency-Key': 'proposal-' + tag },
      body: JSON.stringify({ slotId: slots[0]!.id, serviceId: service.id, durationMinutes: 120 }) });
    assert.equal(proposalResult.status, 201);
    const proposal = BookingProposalResponseSchema.parse(await proposalResult.json());
    assert.equal(await db.booking.count({ where: { businessId: business.id } }), 0);
    assert.equal(await db.availabilitySlot.count({ where: { businessId: business.id, state: 'RESERVED' } }), 0);
    const customer = { name: 'Synthetic Restart ' + tag, email: 'restart-' + tag + '@example.test' };
    const key = 'confirm-' + tag;
    const body = JSON.stringify({ proposalId: proposal.id, customer });
    const original = await fetch(base + '/customer/bookings', { method: 'POST', headers: { ...headers, cookie, 'Idempotency-Key': key }, body });
    assert.equal(original.status, 201);
    // Deliberately discard the first response; recover solely by the stable key.
    await original.arrayBuffer();
    const saved = await db.booking.findUniqueOrThrow({ where: { proposalId: proposal.id } });
    await stop(); await start();
    const retry = await fetch(base + '/customer/bookings', { method: 'POST', headers: { ...headers, cookie, 'Idempotency-Key': key }, body });
    assert.equal(retry.status, 200);
    const booking = BookingResponseSchema.parse(await retry.json());
    assert.equal(booking.id, saved.id);
    assert.equal(booking.reference, saved.reference);
    const read = await fetch(base + '/customer/bookings/' + booking.id, { headers: { cookie } });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), booking);
    const another = await fetch(base + '/customer/sessions', { method: 'POST', headers, body: JSON.stringify({ businessSlug: business.slug }) });
    assert.equal(another.status, 201);
    const otherCookie = another.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(base + '/customer/bookings/' + booking.id, { headers: { cookie: otherCookie } })).status, 404);
    const date = businessDate(new Date(first), business.timezone);
    const available = await fetch(base + `/customer/availability?date=${date}&serviceId=${service.id}&durationMinutes=30`, { headers: { cookie } });
    assert.equal(available.status, 200);
    const list = await available.json() as { items: { slotId: string }[] };
    assert.equal(list.items.some((item) => slots.slice(0, 4).some((slot) => slot.id === item.slotId)), false);
    assert.equal(await db.booking.count({ where: { businessId: business.id } }), 1);
    assert.equal(await db.bookingSlot.count({ where: { businessId: business.id } }), 4);
    assert.equal(await db.bookingAction.count({ where: { businessId: business.id, operation: 'CONFIRM' } }), 1);
    assert.equal(await db.auditEvent.count({ where: { businessId: business.id, eventType: 'BOOKING_CONFIRMED' } }), 1);
    const logout = await fetch(base + '/customer/logout', { method: 'POST', headers: { ...headers, cookie }, body: '{}' });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(base + '/customer/bookings/' + booking.id, { headers: { cookie } })).status, 401);
    await stop();
    const token = cookie.split('=')[1]!;
    const hash = createHash('sha256').update(token).digest('hex');
    for (const secret of [token, hash, customer.name, customer.email, key, chatMessage]) {
      assert.equal(logs.includes(secret), false, 'Runtime logs must not expose customer identity, secrets or submission keys.');
    }
    assert.ok(logs.includes('request completed'), 'Assert redaction against actual request logs.');
  } finally {
    await stop();
    try {
      await db.$transaction(async (tx) => {
        await tx.auditEvent.deleteMany({ where: { businessId: business.id } });
        await tx.bookingAction.deleteMany({ where: { businessId: business.id } });
        await tx.bookingSlot.deleteMany({ where: { businessId: business.id } });
        await tx.booking.deleteMany({ where: { businessId: business.id } });
        await tx.bookingProposal.deleteMany({ where: { businessId: business.id } });
        await tx.customerSession.deleteMany({ where: { businessId: business.id } });
        await tx.availabilitySlot.deleteMany({ where: { businessId: business.id } });
        await tx.service.deleteMany({ where: { businessId: business.id } });
        await tx.staff.deleteMany({ where: { businessId: business.id } });
        await tx.business.delete({ where: { id: business.id } });
      });
    } finally { await db.$disconnect(); }
  }
});
