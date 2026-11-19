import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createDatabaseClient, businessDate, addCalendarDays, localBusinessInstant } from '../../../packages/db/dist/index.js';

const base = process.env.FLOWPILOT_URL || 'http://127.0.0.1:5173';
const step = Number(process.env.FLOWPILOT_CUSTOMER_STEP || 4);
const database = process.env.DATABASE_URL;
if (!database || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(database).hostname) || !['/flowpilot', '/flowpilot_test'].includes(new URL(database).pathname)) throw new Error('Customer browser tests require a local demo/test database.');
const db = createDatabaseClient(database);
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const business = await db.business.create({ data: { slug: 'browser-' + randomUUID(), name: 'Synthetic Customer Browser' } });
try {
  const people = await Promise.all(['Alex', 'Jamie'].map((displayName) => db.staff.create({ data: { businessId: business.id, slug: displayName.toLowerCase(), displayName } })));
  await db.service.createMany({ data: ['Haircut', 'Consultation'].map((name) => ({ businessId: business.id, slug: name.toLowerCase(), name })) });
  const date = addCalendarDays(businessDate(new Date(), business.timezone), 1);
  const display = (value) => value.split('-').reverse().join('-');
  for (const person of people) {
    const slots = [];
    for (let minutes = 540; minutes < 1020; minutes += 30) {
      if (minutes >= 720 && minutes < 780) continue;
      const startAt = localBusinessInstant(date, business.timezone, Math.floor(minutes / 60), minutes % 60);
      slots.push({ businessId: business.id, staffId: person.id, startAt, endAt: new Date(+startAt + 1800000) });
    }
    await db.availabilitySlot.createMany({ data: slots });
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const confirmations = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/customer/bookings')) confirmations.push({ key: request.headers()['idempotency-key'], body: request.postData() }); });
  await page.goto(base + '/book');
  await page.getByLabel('Business', { exact: true }).fill(business.slug);
  await page.getByRole('button', { name: 'Start booking', exact: true }).click();
  await page.getByText(business.name, { exact: true }).waitFor();
  await page.getByLabel('Service', { exact: true }).selectOption({ label: 'Haircut' });
  await page.getByLabel('Duration', { exact: true }).selectOption('60');
  await page.getByLabel('Appointment date (dd-mm-yyyy)').fill('31-02-2030');
  await page.getByRole('button', { name: 'View appointments', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Enter a valid date' }).waitFor();
  await page.getByLabel('Appointment date (dd-mm-yyyy)').fill(display(date));
  await page.getByRole('button', { name: 'View appointments', exact: true }).click();
  await page.getByText('24 available starts', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Next appointments', exact: true }).click();
  await page.getByText('Page 2 of 3', { exact: true }).waitFor();
  await page.getByLabel('Preferred staff').selectOption({ label: 'Alex' });
  await page.getByRole('button', { name: 'View appointments', exact: true }).click();
  await page.getByText('12 available starts', { exact: false }).waitFor();
  assert.equal(await db.booking.count({ where: { businessId: business.id } }), 0);
  assert.equal(await db.bookingProposal.count({ where: { businessId: business.id } }), 0);
  assert.equal(await page.getByLabel('Duration', { exact: true }).locator('option').count(), 4);
  console.log('PASS Step 1: public session, active catalogs, dd-mm-yyyy validation, duration/staff filters and real paginated availability.');

  if (step >= 2) {
    let loseProposal = true;
    await page.route('**/api/v1/customer/booking-proposals', async (route) => {
      if (loseProposal) { loseProposal = false; const result = await route.fetch(); assert.equal(result.status(), 201); await route.abort('failed'); }
      else await route.continue();
    });
    await page.getByRole('button', { name: /^Select Alex/ }).first().click();
    await page.getByRole('button', { name: 'Retry selection', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry selection', exact: true }).click();
    await page.getByRole('heading', { name: 'Review appointment', exact: true }).waitFor();
    await page.getByText(/GMT\+10/).first().waitFor();
    assert.equal(await db.bookingProposal.count({ where: { businessId: business.id } }), 1);
    assert.equal(await db.booking.count({ where: { businessId: business.id } }), 0);
    await page.reload();
    await page.getByRole('heading', { name: 'Review appointment', exact: true }).waitFor();
    assert.equal(await db.booking.count({ where: { businessId: business.id } }), 0, 'Reload must never confirm.');
    let loseConfirmation = true;
    await page.route('**/api/v1/customer/bookings', async (route) => {
      if (loseConfirmation) { loseConfirmation = false; const result = await route.fetch(); assert.equal(result.status(), 201); await route.abort('failed'); }
      else await route.continue();
    });
    await page.getByRole('button', { name: 'Confirm booking', exact: true }).click();
    await page.getByRole('button', { name: 'Retry same confirmation', exact: true }).waitFor();
    await page.getByRole('alert').filter({ hasText: 'Could not reach the API' }).waitFor();
    assert.equal(await db.booking.count({ where: { businessId: business.id } }), 1);
    assert.equal(await page.getByRole('button', { name: 'Choose another appointment', exact: true }).isDisabled(), true);
    const rotated = await context.request.post(base + '/api/v1/customer/sessions', { headers: { Origin: new URL(base).origin, 'X-Flowpilot-Client': 'web' }, data: { businessSlug: business.slug } });
    assert.equal(rotated.status(), 201);
    await page.reload();
    await page.getByRole('button', { name: 'Retry same confirmation', exact: true }).click();
    await page.getByRole('heading', { name: 'Appointment confirmed', exact: true }).waitFor();
    assert.equal(confirmations.length, 2);
    assert.deepEqual(confirmations[0], confirmations[1], 'Lost-response recovery keeps the exact key/body across reload.');
    const saved = await db.booking.findFirstOrThrow({ where: { businessId: business.id } });
    assert.equal(await db.bookingSlot.count({ where: { bookingId: saved.id } }), 2);
    assert.equal(await db.bookingAction.count({ where: { bookingId: saved.id } }), 1);
    await page.reload();
    await page.getByRole('heading', { name: 'Appointment confirmed', exact: true }).waitFor();
    assert.equal(confirmations.length, 2, 'Success restore uses an owned read, not another write.');
    console.log('PASS Step 2: trusted review, no implicit confirmation, dropped proposal/confirmation responses, stable reload retries and owned success restore.');
    await page.getByRole('button', { name: 'Book another appointment', exact: true }).click();
  }
  if (step >= 3) {
    const before = await db.bookingProposal.count({ where: { businessId: business.id } });
    const staffBeforeClarification = await page.getByLabel('Preferred staff').inputValue();
    await page.getByLabel('Message', { exact: true }).fill('Haircut tomorrow');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByLabel('Chat messages').getByText(/How long would you like/).waitFor();
    assert.equal(await page.getByLabel('Preferred staff').inputValue(), staffBeforeClarification, 'Incomplete chat must not overwrite the form.');
    await page.getByLabel('Message', { exact: true }).fill('60 minutes with Alex');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByLabel('Chat messages').getByText(/Nothing is booked yet/).waitFor();
    assert.equal(await page.getByLabel('Appointment date (dd-mm-yyyy)').inputValue(), display(date));
    assert.equal(await page.getByLabel('Duration', { exact: true }).inputValue(), '60');
    assert.equal(await page.getByLabel('Preferred staff').inputValue(), people[0].id);
    await page.getByLabel('Message', { exact: true }).fill('yes confirm');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByLabel('Chat messages').getByText(/Chat cannot confirm/).waitFor();
    assert.equal(await db.bookingProposal.count({ where: { businessId: business.id } }), before);
    assert.equal(confirmations.length, 2);
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('Haircut tomorrow')), false);
    await page.reload();
    await page.getByText(business.name, { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Chat messages').locator('li').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.FLOWPILOT_CUSTOMER_SCREENSHOT) await page.screenshot({ path: process.env.FLOWPILOT_CUSTOMER_SCREENSHOT, fullPage: true });
    console.log('PASS Step 3: multi-turn clarification, automatic complete form fill including staff, business-local dates, no chat writes/consent, transient transcript and mobile layout.');
  }
  if (step >= 4) {
    // Chat failure leaves manual input usable.
    await page.route('**/api/v1/customer/chat/messages', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_READY', message: 'Synthetic assistant unavailable.', traceId: 'chat-fallback' }) }));
    await page.getByLabel('Message', { exact: true }).fill('Haircut tomorrow');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic assistant unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'View appointments', exact: true }).isEnabled(), true);
    await page.unroute('**/api/v1/customer/chat/messages');
    // A competing state change after proposal review produces a visible conflict,
    // no duplicate booking and a fresh manual selection path.
    await page.getByLabel('Service', { exact: true }).selectOption({ label: 'Haircut' });
    await page.getByLabel('Appointment date (dd-mm-yyyy)').fill(display(date));
    await page.getByLabel('Preferred staff').selectOption({ label: 'Alex' });
    await page.getByRole('button', { name: 'View appointments', exact: true }).click();
    await page.getByRole('button', { name: /^Select Alex/ }).first().click();
    await page.getByRole('heading', { name: 'Review appointment', exact: true }).waitFor();
    const proposal = await db.bookingProposal.findFirstOrThrow({ where: { businessId: business.id, booking: null }, orderBy: { createdAt: 'desc' } });
    const conflicting = await db.availabilitySlot.findFirstOrThrow({ where: { businessId: business.id, staffId: proposal.staffId, startAt: proposal.startAt } });
    await db.availabilitySlot.update({ where: { id: conflicting.id }, data: { state: 'BLOCKED' } });
    await page.getByRole('button', { name: 'Confirm booking', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'View availability again' }).waitFor();
    assert.equal(await db.booking.count({ where: { businessId: business.id } }), 1);
    assert.equal(await page.getByRole('button', { name: 'View appointments', exact: true }).isEnabled(), true);
    await db.availabilitySlot.update({ where: { id: conflicting.id }, data: { state: 'AVAILABLE' } });
    // An expired server-shaped proposal disables a first confirmation locally.
    await page.route('**/api/v1/customer/booking-proposals', async (route) => {
      const response = await route.fetch(); const value = await response.json();
      value.createdAt = new Date(Date.now() - 600000).toISOString(); value.expiresAt = new Date(Date.now() - 300000).toISOString();
      await route.fulfill({ response, json: value });
    });
    await page.getByRole('button', { name: 'View appointments', exact: true }).click();
    await page.getByRole('button', { name: /^Select Alex/ }).first().click();
    await page.getByText(/Proposal expired\./).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm booking', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Choose another appointment', exact: true }).click();
    await page.unroute('**/api/v1/customer/booking-proposals');
    // Session revocation clears UI/draft/chat, with no recovery by reference.
    await context.request.post(base + '/api/v1/customer/logout', { headers: { Origin: new URL(base).origin, 'X-Flowpilot-Client': 'web' }, data: {} });
    await page.reload();
    await page.getByRole('button', { name: 'Start booking', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('flowpilot.customer.booking.v1')), null);
    console.log('PASS Step 4: manual fallback on chat failure, conflict rollback/reselection, expired-review guard and revoked-session cleanup.');
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
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
