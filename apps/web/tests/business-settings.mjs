import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createDatabaseClient, hashPassword } from '../../../packages/db/dist/index.js';

const base = new URL(process.env.FLOWPILOT_URL ?? 'http://127.0.0.1:5173');
const database = process.env.DATABASE_URL;
if (!database || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(database).hostname) || !['/flowpilot', '/flowpilot_test'].includes(new URL(database).pathname) ||
  base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Use local synthetic demo/test endpoints.');
const db = createDatabaseClient(database);
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const tag = randomUUID();
const password = 'synthetic-settings-' + tag;
const business = await db.business.create({ data: { slug: 'settings-browser-' + tag, name: 'Synthetic Settings Browser' } });
const users = [];
try {
  const passwordHash = await hashPassword(password);
  for (const [index, role] of ['OWNER', 'STAFF'].entries()) {
    const user = await db.user.create({ data: { email: `settings-browser-${tag}-${index}@example.test`, role: index === 0 ? 'CLIENT' : 'ADMIN', passwordHash } });
    users.push(user);
    await db.businessMembership.create({ data: { userId: user.id, businessId: business.id, role } });
  }
  const ownerContext = await browser.newContext();
  const page = await ownerContext.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function login(page, user) {
    await page.goto(base.href);
    await page.getByLabel('Email', { exact: true }).fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: business.name, exact: true }).waitFor();
    await page.getByText('Current maximum appointment length:', { exact: false }).waitFor();
  }
  const settingsPanel = (target) => target.getByRole('region', { name: 'Booking settings', exact: true });
  const maximum = () => page.getByLabel('Maximum appointment length', { exact: true });
  await login(page, users[0]);
  assert.equal(await maximum().inputValue(), '120');
  const stale = await ownerContext.newPage();
  await stale.goto(base.href);
  await stale.getByLabel('Maximum appointment length', { exact: true }).waitFor();

  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  await customer.goto(new URL('/book', base).href);
  await customer.getByLabel('Business', { exact: true }).fill(business.slug);
  await customer.getByRole('button', { name: 'Start booking', exact: true }).click();
  await customer.getByText(/up to 120 minutes/).waitFor();

  const attempts = [];
  let loseResponse = true;
  await page.route('**/api/v1/admin/business/booking-settings', async (route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    if (loseResponse) {
      loseResponse = false;
      const result = await route.fetch(); assert.equal(result.status(), 200);
      await route.abort('failed');
    } else await route.continue();
  });
  await maximum().selectOption('60');
  await page.getByRole('button', { name: 'Save booking settings', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same save', exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: 'Retry the same save' }).waitFor();
  assert.equal((await db.business.findUniqueOrThrow({ where: { id: business.id } })).maxBookingDurationMinutes, 60);
  assert.equal(await maximum().isDisabled(), true);
  await page.getByRole('button', { name: 'Retry same save', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Booking settings saved' }).waitFor();
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(await db.auditEvent.count({ where: { businessId: business.id } }), 1);
  await page.unroute('**/api/v1/admin/business/booking-settings');
  await page.reload(); await maximum().waitFor(); assert.equal(await maximum().inputValue(), '60');

  await customer.getByRole('button', { name: 'Refresh customer setup', exact: true }).click();
  await customer.getByText(/up to 60 minutes/).waitFor();
  assert.deepEqual(await customer.getByLabel('Duration', { exact: true }).locator('option').evaluateAll((options) => options.map((option) => option.value)), ['30', '60']);

  await stale.getByLabel('Maximum appointment length', { exact: true }).selectOption('90');
  await stale.getByRole('button', { name: 'Save booking settings', exact: true }).click();
  await stale.getByRole('alert').filter({ hasText: 'Settings changed' }).waitFor();
  assert.equal(await stale.getByRole('button', { name: 'Save booking settings', exact: true }).isDisabled(), true);
  await stale.getByRole('button', { name: 'Refresh settings', exact: true }).click();
  await stale.waitForFunction(() => document.querySelector('#booking-maximum')?.value === '60' && !document.querySelector('#booking-maximum')?.disabled);
  await stale.getByLabel('Maximum appointment length', { exact: true }).selectOption('90');
  await stale.getByRole('button', { name: 'Save booking settings', exact: true }).click();
  await stale.getByRole('status').filter({ hasText: 'Booking settings saved' }).waitFor();

  // A confirmed write followed by a failed GET needs a read refresh, not a new write.
  let failRead = false;
  await page.getByRole('button', { name: 'Refresh settings', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#booking-maximum')?.value === '90' && !document.querySelector('#booking-maximum')?.disabled);
  await page.route('**/api/v1/admin/business/booking-settings', async (route) => {
    if (route.request().method() === 'PUT') { const result = await route.fetch(); failRead = true; await route.fulfill({ response: result }); }
    else if (failRead) { failRead = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_READY', message: 'Synthetic read failure.', traceId: 'settings-check' }) }); }
    else await route.continue();
  });
  await maximum().selectOption('120');
  await page.getByRole('button', { name: 'Save booking settings', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your save succeeded' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save booking settings', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Refresh settings', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#booking-maximum')?.value === '120' && !document.querySelector('#booking-maximum')?.disabled);
  await page.unroute('**/api/v1/admin/business/booking-settings');
  assert.equal(await db.auditEvent.count({ where: { businessId: business.id } }), 3);
  const staffContext = await browser.newContext(); const staffPage = await staffContext.newPage();
  await login(staffPage, users[1]);
  assert.equal(await staffPage.getByLabel('Maximum appointment length', { exact: true }).count(), 0);
  assert.equal(await staffPage.getByRole('button', { name: 'Save booking settings', exact: true }).count(), 0);
  await settingsPanel(staffPage).getByText('Only a business owner can change this limit.', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.FLOWPILOT_SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.FLOWPILOT_SETTINGS_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: owner settings editor, durable lost-response retry, stale-edit conflict, post-save read recovery, staff read-only, customer duration refresh and mobile layout.');
} finally {
  await browser.close();
  try {
    await db.auditEvent.deleteMany({ where: { businessId: business.id } });
    await db.customerSession.deleteMany({ where: { businessId: business.id } });
    await db.businessMembership.deleteMany({ where: { businessId: business.id } });
    await db.business.delete({ where: { id: business.id } });
    await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  } finally { await db.$disconnect(); }
}
