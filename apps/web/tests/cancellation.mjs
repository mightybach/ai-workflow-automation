import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { addCalendarDays, businessDate, createDatabaseClient, localBusinessInstant } from '../../../packages/db/dist/index.js';

const base = new URL(process.env.FLOWPILOT_URL ?? 'http://127.0.0.1:5173'); const database = process.env.DATABASE_URL;
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) || !['/flowpilot', '/flowpilot_test'].includes(new URL(database).pathname) || base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Use local synthetic demo/test endpoints.');
const db = createDatabaseClient(database); const tag = randomUUID();
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const business = await db.business.create({ data: { slug: 'cancel-browser-' + tag, name: 'Synthetic Cancellation Browser' } });
try {
  const staff = await db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } });
  const service = await db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } });
  const date = addCalendarDays(businessDate(new Date(), business.timezone), 1); const start = localBusinessInstant(date, business.timezone, 9);
  const slots = [];
  for (let n = 0; n < 4; n++) slots.push(await db.availabilitySlot.create({ data: { businessId: business.id, staffId: staff.id, startAt: new Date(+start + n * 1800000), endAt: new Date(+start + (n + 1) * 1800000) } }));
  const context = await browser.newContext(); const page = await context.newPage(); const errors = []; const writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.method() === 'POST' && /\/bookings\/[^/]+\/cancel$/.test(request.url())) writes.push({ url: request.url(), key: request.headers()['idempotency-key'], body: request.postData() }); });
  await page.goto(new URL('/book', base).href); await page.getByLabel('Business', { exact: true }).fill(business.slug);
  await page.getByRole('button', { name: 'Start booking', exact: true }).click(); await page.getByText(business.name, { exact: true }).waitFor();
  await page.getByLabel('Appointment date (dd-mm-yyyy)').fill(date.split('-').reverse().join('-')); await page.getByLabel('Duration', { exact: true }).selectOption('120');
  await page.getByRole('button', { name: 'View appointments', exact: true }).click(); await page.getByRole('button', { name: /^Select Alex/ }).first().click();
  await page.getByRole('button', { name: 'Confirm booking', exact: true }).click(); await page.getByRole('heading', { name: 'Appointment confirmed', exact: true }).waitFor();
  const booking = await db.booking.findFirstOrThrow({ where: { businessId: business.id } });
  const available = async () => (await (await context.request.get(new URL(`/api/v1/customer/availability?date=${date}&serviceId=${service.id}&staffId=${staff.id}&durationMinutes=120`, base).href)).json()).pagination.total;
  assert.equal(await available(), 0);
  await page.getByRole('button', { name: 'Review cancellation', exact: true }).click();
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'CONFIRMED'); assert.equal(writes.length, 0);
  await page.getByRole('button', { name: 'Keep appointment', exact: true }).click(); assert.equal(writes.length, 0);
  // Browser retry storage is required before any cancellation request.
  await page.evaluate(() => { const original = Storage.prototype.setItem; window.restoreStorageForTest = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = () => { throw new Error('Synthetic unavailable storage'); }; });
  await page.getByRole('button', { name: 'Review cancellation', exact: true }).click(); await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'cannot save the retry information' }).waitFor(); assert.equal(writes.length, 0);
  await page.evaluate(() => window.restoreStorageForTest());
  let drop = true; let throttle = true;
  await page.route('**/api/v1/customer/bookings/*/cancel', async (route) => {
    if (drop) { drop = false; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); }
    else if (throttle) { throttle = false; await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ code: 'RATE_LIMITED', message: 'Synthetic retry delay.', traceId: 'synthetic-test' }) }); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Retry the same cancellation' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'End customer session', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Book another appointment', exact: true }).isDisabled(), true);
  assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id, releasedAt: null } }), 0); assert.equal(await available(), 1);
  const rotation = await context.request.post(new URL('/api/v1/customer/sessions', base).href, { headers: { Origin: base.origin, 'X-Flowpilot-Client': 'web' }, data: { businessSlug: business.slug } }); assert.equal(rotation.status(), 201);
  await page.reload(); await page.getByRole('heading', { name: 'Appointment cancelled', exact: true }).waitFor();
  assert.equal(writes.length, 1, 'Restore is a read and never retries a cancellation automatically.');
  await page.getByRole('button', { name: 'Retry same cancellation', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic retry delay' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'End customer session', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Retry same cancellation', exact: true }).click();
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('flowpilot.customer.booking.v1')).cancellation);
  assert.equal(writes.length, 3); assert.deepEqual(writes[0], writes[1]); assert.deepEqual(writes[0], writes[2]);
  assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id } }), 4); assert.equal(await db.auditEvent.count({ where: { entityId: booking.id, eventType: 'BOOKING_CANCELLED' } }), 1);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).reference, booking.reference);
  await page.reload(); await page.getByRole('heading', { name: 'Appointment cancelled', exact: true }).waitFor(); assert.equal(writes.length, 3);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Book another appointment', exact: true }).click(); await page.getByRole('heading', { name: 'Choose appointment details', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: explicit review/keep/cancel, storage failure prevents writes, four-slot release, customer availability, lost-response reload/rotation retry, retained history/reference and mobile layout.');
} finally {
  await browser.close();
  try { await db.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany({ where: { businessId: business.id } }); await tx.notificationOutbox.deleteMany({ where: { businessId: business.id } }); await tx.bookingAction.deleteMany({ where: { businessId: business.id } });
    await tx.bookingSlot.deleteMany({ where: { businessId: business.id } }); await tx.booking.deleteMany({ where: { businessId: business.id } });
    await tx.bookingProposal.deleteMany({ where: { businessId: business.id } }); await tx.customerSession.deleteMany({ where: { businessId: business.id } });
    await tx.availabilitySlot.deleteMany({ where: { businessId: business.id } }); await tx.service.deleteMany({ where: { businessId: business.id } });
    await tx.staff.deleteMany({ where: { businessId: business.id } }); await tx.business.delete({ where: { id: business.id } });
  }); } finally { await db.$disconnect(); }
}
