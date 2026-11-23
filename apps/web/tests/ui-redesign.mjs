import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createDatabaseClient, hashPassword, businessDate, addCalendarDays, localBusinessInstant } from '../../../packages/db/dist/index.js';
import { workflowBatch } from '../../api/dist/workflow-executor.js';
const base = new URL(process.env.FLOWPILOT_URL ?? 'http://127.0.0.1:5173'); const database = process.env.DATABASE_URL;
if (!database || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(database).hostname) || !['/flowpilot', '/flowpilot_test'].includes(new URL(database).pathname) || base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Use local synthetic endpoints.');
const db = createDatabaseClient(database); const tag = randomUUID(); const password = 'synthetic-ui-' + tag;
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const business = await db.business.create({ data: { slug: 'design-' + tag, name: 'Willow & Co. Studio' } }); const users = [];
const directory = process.env.FLOWPILOT_UI_SCREENSHOT_DIR;
if (directory) await mkdir(directory, { recursive: true });
try {
  const hash = await hashPassword(password);
  for (const [index, role] of ['OWNER', 'STAFF'].entries()) { const user = await db.user.create({ data: { email: `design-${tag}-${index}@example.test`, passwordHash: hash, role: 'CLIENT' } }); users.push(user); await db.businessMembership.create({ data: { userId: user.id, businessId: business.id, role } }); }
  const staff = await Promise.all(['Alex', 'Jamie'].map((displayName) => db.staff.create({ data: { businessId: business.id, slug: displayName.toLowerCase(), displayName } })));
  const services = await Promise.all(['Haircut', 'Consultation'].map((name) => db.service.create({ data: { businessId: business.id, slug: name.toLowerCase(), name } })));
  const date = addCalendarDays(businessDate(new Date(), business.timezone), 1); const start = localBusinessInstant(date, business.timezone, 10);
  const slot = await db.availabilitySlot.create({ data: { businessId: business.id, staffId: staff[0].id, startAt: start, endAt: new Date(+start + 1800000) } });
  const owner = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 1050 } }); const page = await owner.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base.href); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click(); await page.reload(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  if (directory) await page.screenshot({ path: directory + '/login-light.png' });
  const login = async (target, user) => { await target.getByLabel('Email', { exact: true }).fill(user.email); await target.getByLabel('Password', { exact: true }).fill(password); await target.getByRole('button', { name: 'Sign in', exact: true }).click(); await target.getByRole('heading', { name: business.name, exact: true }).waitFor(); };
  await login(page, users[0]);
  assert.equal(await page.locator('#appointments').count(), 0);
  assert.equal(await page.locator('#settings').count(), 0);
  assert.equal(await page.getByRole('region', { name: 'Staff', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByText('Current maximum appointment length:', { exact: false }).waitFor();
  await page.getByLabel('Maximum appointment length', { exact: true }).selectOption('90');
  await page.getByRole('link', { name: 'Team', exact: true }).click();
  await page.getByRole('region', { name: 'Staff', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Booking settings', exact: true }).count(), 0);
  await page.goBack();
  assert.equal(await page.getByLabel('Maximum appointment length', { exact: true }).inputValue(), '90');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  assert.equal(await page.locator('.app-rail nav').evaluate((nav) => [...nav.querySelectorAll('.rail-item')].every((item) => { const box = item.getBoundingClientRect(); const icon = item.querySelector('svg')?.getBoundingClientRect(); return icon && Math.abs(box.left + box.width / 2 - icon.left - icon.width / 2) <= 1; })), true);
  const headers = { Origin: base.origin, 'X-Flowpilot-Client': 'web', 'Idempotency-Key': randomUUID() };
  const policies = await owner.request.get(new URL('/api/v1/admin/workflows', base).href); const preparation = (await policies.json()).items.find((row) => row.template === 'PREPARE_APPOINTMENT');
  assert.equal((await owner.request.put(new URL('/api/v1/admin/workflows/' + preparation.id, base).href, { headers, data: { enabled: true, expectedRevision: preparation.revision } })).status(), 200);
  const customer = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  assert.equal((await customer.request.post(new URL('/api/v1/customer/sessions', base).href, { headers, data: { businessSlug: business.slug } })).status(), 201);
  const proposed = await customer.request.post(new URL('/api/v1/customer/booking-proposals', base).href, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { slotId: slot.id, serviceId: services[0].id, durationMinutes: 30 } }); assert.equal(proposed.status(), 201);
  const confirmed = await customer.request.post(new URL('/api/v1/customer/bookings', base).href, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { proposalId: (await proposed.json()).id, customer: { name: 'Synthetic', email: 'demo@example.test' } } }); assert.equal(confirmed.status(), 201); const savedBooking = await confirmed.json();
  await workflowBatch(db, { businessId: business.id }); await page.getByRole('button', { name: 'Refresh setup', exact: true }).click();
  const dateLabel = date.split('-').reverse().join('-');
  if (date.slice(0, 7) !== businessDate(new Date(), business.timezone).slice(0, 7)) await page.getByRole('button', { name: 'Next calendar month', exact: true }).click();
  await page.getByRole('button', { name: 'View inventory ' + dateLabel, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.metric-card[href="#appointments"] strong')?.textContent === '1');
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  assert.equal(await page.getByLabel('Date', { exact: true }).inputValue(), dateLabel);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  assert.equal(await page.locator('.metric-card[href="#team"] strong').textContent(), '2');
  await page.waitForFunction(() => document.querySelector('.metric-card[href="#workflows"] strong')?.textContent === '1');
  await page.getByRole('link', { name: 'Bookings', exact: true }).click();
  const bookingPanel = page.getByRole('region', { name: 'Bookings and history', exact: true });
  await bookingPanel.getByLabel('Booking date (dd-mm-yyyy, empty for all)', { exact: true }).fill(dateLabel);
  const reviewBooking = bookingPanel.getByRole('button', { name: 'Review cancellation for ' + savedBooking.reference, exact: true }); await reviewBooking.waitFor();
  assert.equal(await bookingPanel.locator('.booking-record-actions').evaluate((group) => {
    const [first, second] = [...group.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
    return second.top >= first.bottom - 1 ? second.top - first.bottom >= 10 : second.left - first.right >= 10;
  }), true);
  await reviewBooking.click(); const confirmButton = bookingPanel.getByRole('button', { name: 'Confirm business cancellation', exact: true }); const keepButton = bookingPanel.getByRole('button', { name: 'Keep business appointment', exact: true });
  const first = await confirmButton.boundingBox(); const second = await keepButton.boundingBox(); assert.ok(second.y >= first.y + first.height - 1 ? second.y - first.y - first.height >= 10 : second.x - first.x - first.width >= 10); await keepButton.click();
  await bookingPanel.getByRole('button', { name: 'View history for ' + savedBooking.reference, exact: true }).click();
  const auditField = await bookingPanel.getByLabel('Audit date (dd-mm-yyyy, empty for all)', { exact: true }).boundingBox(); const clearHistory = await bookingPanel.getByRole('button', { name: 'Show all business history', exact: true }).boundingBox(); assert.ok(clearHistory.y - auditField.y - auditField.height >= 10);
  await page.getByRole('button', { name: 'Close booking details', exact: true }).click();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.evaluate(() => scrollTo(0, 0)); if (directory) await page.screenshot({ path: directory + '/dashboard-light.png' });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click(); if (directory) await page.screenshot({ path: directory + '/dashboard-dark.png' });
  const bookingPage = await owner.newPage(); await bookingPage.goto(new URL('/book', base).href); assert.equal(await bookingPage.locator('html').getAttribute('data-theme'), 'dark');
  await bookingPage.getByRole('button', { name: 'Switch to light mode', exact: true }).click(); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  const customerPage = await customer.newPage(); await customerPage.goto(new URL('/book', base).href); await customerPage.getByRole('heading', { name: 'Choose appointment details', exact: true }).waitFor();
  assert.equal(await customerPage.getByRole('list', { name: 'Booking progress', exact: true }).locator('[aria-current="step"]').innerText(), '02\nChoose a time');
  if (directory) await customerPage.screenshot({ path: directory + '/booking-light.png', fullPage: true });
  await customerPage.getByRole('button', { name: 'Switch to dark mode', exact: true }).click(); await customerPage.reload(); assert.equal(await customerPage.locator('html').getAttribute('data-theme'), 'dark');
  await customerPage.getByRole('heading', { name: 'Choose appointment details', exact: true }).waitFor(); if (directory) await customerPage.screenshot({ path: directory + '/booking-dark.png', fullPage: true });
  const staffContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); const staffPage = await staffContext.newPage(); await staffPage.goto(base.href); await login(staffPage, users[1]);
  await staffPage.getByRole('link', { name: 'Workflows', exact: true }).click();
  await staffPage.getByText('Appointment preparation', { exact: true }).waitFor();
  assert.equal(await staffPage.getByRole('button', { name: /Review enable|Review disable/ }).count(), 0);
  await staffPage.getByRole('link', { name: 'Overview', exact: true }).click();
  if (directory) await staffPage.screenshot({ path: directory + '/staff-light.png' });
  for (const target of [page, customerPage, staffPage]) {
    await target.setViewportSize({ width: 390, height: 844 }); await target.evaluate(() => scrollTo(0, 0));
    if (target !== customerPage) assert.equal(await target.locator('.app-rail nav').evaluate((nav) => [...nav.querySelectorAll('.rail-item')].every((item) => { const box = item.getBoundingClientRect(); const icon = item.querySelector('svg')?.getBoundingClientRect(); return icon && Math.abs(box.left + box.width / 2 - icon.left - icon.width / 2) <= 1; })), true);
    for (const theme of ['light', 'dark']) {
      if (await target.locator('html').getAttribute('data-theme') !== theme) await target.getByRole('button', { name: `Switch to ${theme} mode`, exact: true }).click();
      assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (directory) await target.screenshot({ path: directory + `/${target === page ? 'dashboard' : target === customerPage ? 'booking' : 'staff'}-mobile-${theme}.png` });
    }
  }
  const blocked = await browser.newContext({ colorScheme: 'dark' }); await blocked.addInitScript(() => { const original = Storage.prototype.getItem; Storage.prototype.getItem = function (key) { if (key === 'flowpilot.theme') throw new Error('Synthetic storage denial'); return original.call(this, key); }; });
  const fallback = await blocked.newPage(); await fallback.goto(new URL('/book', base).href); assert.equal(await fallback.locator('html').getAttribute('data-theme'), 'dark'); await fallback.getByRole('button', { name: 'Switch to light mode', exact: true }).click(); assert.equal(await fallback.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await db.booking.count({ where: { businessId: business.id } }), 1); assert.equal(await db.businessTask.count({ where: { businessId: business.id } }), 1); assert.deepEqual(errors, []);
  console.log('PASS: real dashboard metrics/calendar, OWNER/STAFF views, light/dark system default, persistence/cross-tab sync/storage fallback, customer progression and desktop/mobile layout.');
} finally {
  await browser.close();
  try { await db.$transaction(async (tx) => { const where = { businessId: business.id };
    await tx.businessWorkflowAction.deleteMany({ where }); await tx.businessTask.deleteMany({ where }); await tx.businessWorkflowRun.deleteMany({ where }); await tx.businessWorkflowDefinition.deleteMany({ where });
    await tx.notificationOutbox.deleteMany({ where }); await tx.auditEvent.deleteMany({ where }); await tx.bookingAction.deleteMany({ where }); await tx.bookingSlot.deleteMany({ where }); await tx.booking.deleteMany({ where }); await tx.bookingProposal.deleteMany({ where }); await tx.customerSession.deleteMany({ where }); await tx.availabilitySlot.deleteMany({ where }); await tx.staff.deleteMany({ where }); await tx.service.deleteMany({ where });
    await tx.session.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } }); await tx.businessMembership.deleteMany({ where }); await tx.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } }); await tx.business.delete({ where: { id: business.id } });
  }); } finally { await db.$disconnect(); }
}
