import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { addCalendarDays, businessDate, createDatabaseClient, localBusinessInstant } from '../../../packages/db/dist/index.js';

const base = new URL(process.env.FLOWPILOT_URL ?? 'http://127.0.0.1:5173'); const database = process.env.DATABASE_URL;
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) || !['/flowpilot', '/flowpilot_test'].includes(new URL(database).pathname) || base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Use local synthetic demo/test endpoints.');
const db = createDatabaseClient(database); const tag = randomUUID();
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const business = await db.business.create({ data: { slug: 'reschedule-browser-' + tag, name: 'Synthetic Rescheduling Browser' } });
try {
  const staff = await db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } });
  await db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } });
  const date = addCalendarDays(businessDate(new Date(), business.timezone), 1); const start = localBusinessInstant(date, business.timezone, 9);
  const slots = [];
  for (let n = 0; n < 6; n++) slots.push(await db.availabilitySlot.create({ data: { businessId: business.id, staffId: staff.id, startAt: new Date(+start + n * 1800000), endAt: new Date(+start + (n + 1) * 1800000) } }));
  const context = await browser.newContext(); const page = await context.newPage(); const errors = []; const writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.method() === 'POST' && /\/bookings\/[^/]+\/cancel$/.test(request.url())) writes.push({ url: request.url(), key: request.headers()['idempotency-key'], body: request.postData() }); });
  await page.goto(new URL('/book', base).href); await page.getByLabel('Business', { exact: true }).fill(business.slug);
  await page.getByRole('button', { name: 'Start booking', exact: true }).click(); await page.getByText(business.name, { exact: true }).waitFor();
  await page.getByLabel('Appointment date (dd-mm-yyyy)').fill(date.split('-').reverse().join('-')); await page.getByLabel('Duration', { exact: true }).selectOption('60');
  await page.getByRole('button', { name: 'View appointments', exact: true }).click(); await page.getByRole('button', { name: /^Select Alex/ }).first().click();
  await page.getByRole('button', { name: 'Confirm booking', exact: true }).click(); await page.getByRole('heading', { name: 'Appointment confirmed', exact: true }).waitFor();
  const booking = await db.booking.findFirstOrThrow({ where: { businessId: business.id } });
  const choose = async () => {
    await page.getByRole('button', { name: 'Choose replacement time', exact: true }).click();
    await page.getByLabel('Replacement duration', { exact: true }).selectOption('120');
    await page.getByRole('button', { name: 'View replacement times', exact: true }).click();
    await page.getByRole('button', { name: /^Review replacement Alex/ }).nth(1).click();
    await page.getByRole('heading', { name: 'Review replacement appointment', exact: true }).waitFor();
  };
  await choose();
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status,'CONFIRMED');
  assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id, releasedAt: null } }),2);
  await page.getByRole('button', { name: 'Keep original appointment', exact: true }).click();
  await choose();
  await db.availabilitySlot.update({ where: { id: slots[3].id }, data: { state: 'BLOCKED' } });
  await page.getByRole('button', { name: 'Confirm rescheduling', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your original appointment was kept' }).waitFor();
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status,'CONFIRMED');
  assert.equal(await db.bookingSlot.count({ where: { bookingId: booking.id, releasedAt: null } }),2);
  await db.availabilitySlot.update({ where: { id: slots[3].id }, data: { state: 'AVAILABLE' } });
  await page.getByRole('button', { name: 'View replacement times', exact: true }).click();
  await page.getByRole('button', { name: /^Review replacement Alex/ }).nth(1).click();
  let drop = true;
  await page.route('**/api/v1/customer/bookings/*/reschedule', async (route) => {
    writes.push({ url: route.request().url(), key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    if (drop) { drop=false; const response=await route.fetch(); assert.equal(response.status(),200); await route.abort('failed'); } else await route.continue();
  });
  await page.getByRole('button', { name: 'Confirm rescheduling', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Use the same retry' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'End customer session', exact: true }).isDisabled(),true);
  assert.equal(await page.getByRole('button', { name: 'Book another appointment', exact: true }).isDisabled(),true);
  const rotated = await context.request.post(new URL('/api/v1/customer/sessions',base).href,{ headers:{Origin:base.origin,'X-Flowpilot-Client':'web'},data:{businessSlug:business.slug} }); assert.equal(rotated.status(),201);
  await page.reload();
  await page.getByRole('button', { name: 'Retry same rescheduling', exact: true }).waitFor();
  assert.equal(writes.length,1,'Reload must not execute a rescheduling.');
  await page.getByRole('button', { name: 'Retry same rescheduling', exact: true }).click();
  await page.getByRole('heading', { name: 'Appointment confirmed', exact: true }).waitFor();
  assert.equal(writes.length,2); assert.deepEqual(writes[0],writes[1]);
  const replacement = await db.booking.findFirstOrThrow({where:{businessId:business.id,status:'CONFIRMED'}});
  assert.notEqual(replacement.id,booking.id); assert.equal(await db.bookingSlot.count({where:{bookingId:replacement.id,releasedAt:null}}),4);
  assert.equal(await db.bookingSlot.count({where:{bookingId:booking.id}}),2);
  assert.equal(await db.auditEvent.count({where:{entityId:replacement.id,eventType:'BOOKING_RESCHEDULED'}}),1);
  await page.reload(); await page.getByRole('heading', { name: 'Appointment confirmed', exact: true }).waitFor(); assert.equal(writes.length,2);
  await page.setViewportSize({width:390,height:844}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: overlapping reschedule review/keep, failed replacement preserves original, exact reload/rotation retry, atomic claim/history chain and mobile layout.');
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
