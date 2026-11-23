import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { addCalendarDays, businessDate, createDatabaseClient, hashPassword } from '../../../packages/db/dist/index.js';

const base = new URL(process.env.FLOWPILOT_URL ?? 'http://127.0.0.1:5173');
const database = process.env.DATABASE_URL;
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) || !['/flowpilot', '/flowpilot_test'].includes(new URL(database).pathname) || base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Use local synthetic endpoints.');
const db = createDatabaseClient(database); const tag = randomUUID(); const password = 'policy-' + tag;
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const business = await db.business.create({ data: { slug: 'policy-browser-' + tag, name: 'Synthetic Policy Browser' } });
const users = [];
try {
  const passwordHash = await hashPassword(password);
  for (const [index, role] of ['OWNER', 'STAFF'].entries()) {
    const user = await db.user.create({ data: { email: `policy-${tag}-${index}@example.test`, role: 'CLIENT', passwordHash } }); users.push(user);
    await db.businessMembership.create({ data: { businessId: business.id, userId: user.id, role } });
  }
  const staff = await db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } });
  const service = await db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } });
  const date = addCalendarDays(businessDate(new Date(), business.timezone), 2);
  const context = await browser.newContext(); const page = await context.newPage(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const panel = (target) => target.getByRole('region', { name: 'Working hours and closure rules', exact: true });
  async function login(target, user) {
    await target.goto(base.href); await target.getByLabel('Email', { exact: true }).fill(user.email); await target.getByLabel('Password', { exact: true }).fill(password);
    const response = target.waitForResponse((value) => value.url().endsWith('/api/v1/auth/login') && value.request().method() === 'POST');
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    const result = await response; assert.equal(result.status(), 200, await result.text());
    try { await target.getByRole('heading', { name: business.name, exact: true }).waitFor(); await target.getByRole('link', { name: 'Inventory', exact: true }).click(); }
    catch (cause) { console.error('Dashboard alerts:', await target.getByRole('alert').allTextContents(), 'Page errors:', errors); throw cause; }
  }
  await login(page, users[0]);
  await panel(page).getByLabel('Policy date (dd-mm-yyyy)').fill(date.split('-').reverse().join('-'));
  await page.waitForFunction(() => document.querySelector('#policy-date')?.disabled === false);
  await panel(page).getByLabel('Schedule operation').selectOption('close');
  await panel(page).getByLabel('Window ends').selectOption('600');
  await panel(page).getByRole('button', { name: 'Review closure', exact: true }).click();
  assert.equal(await db.scheduleClosure.count({ where: { businessId: business.id } }), 0);
  await panel(page).getByRole('button', { name: 'Apply schedule policy', exact: true }).click();
  await panel(page).getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
  await panel(page).getByLabel('Schedule operation').selectOption('hours');
  await panel(page).getByLabel('Policy staff').selectOption(staff.id);
  await page.waitForFunction(() => document.querySelector('#policy-date')?.disabled === false);
  await panel(page).getByLabel('Window ends').selectOption('660');
  const writes = []; let drop = true;
  await page.route('**/api/v1/admin/schedule/hours', async (route) => {
    writes.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    if (drop) { drop = false; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); } else await route.continue();
  });
  await panel(page).getByRole('button', { name: 'Review working time', exact: true }).click();
  assert.equal(await db.availabilitySlot.count({ where: { businessId: business.id } }), 0);
  await panel(page).getByRole('button', { name: 'Apply schedule policy', exact: true }).click();
  await panel(page).getByRole('alert').filter({ hasText: 'Retry the same policy change' }).waitFor();
  await panel(page).getByRole('button', { name: 'Retry same policy change', exact: true }).click();
  await panel(page).getByRole('status').filter({ hasText: '4 slots added; 2 blocked' }).waitFor();
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.equal(await db.auditEvent.count({ where: { businessId: business.id } }), 2);
  const customer = await browser.newContext(); const headers = { Origin: base.origin, 'X-Flowpilot-Client': 'web' };
  assert.equal((await customer.request.post(new URL('/api/v1/customer/sessions', base).href, { headers, data: { businessSlug: business.slug } })).status(), 201);
  const available = async () => (await (await customer.request.get(new URL(`/api/v1/customer/availability?date=${date}&staffId=${staff.id}&serviceId=${service.id}&durationMinutes=60`, base).href)).json()).pagination.total;
  assert.equal(await available(), 1);
  await panel(page).getByRole('button', { name: 'Review lift closure', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Apply schedule policy', exact: true }).click();
  await panel(page).getByRole('status').filter({ hasText: 'Closure lifted.' }).waitFor();
  assert.equal(await available(), 1, 'Lifting a closure must preserve blocked inventory.');
  const breaks = page.getByRole('region', { name: 'Breaks and closures', exact: true });
  await breaks.getByLabel('Schedule date (dd-mm-yyyy)').fill(date.split('-').reverse().join('-'));
  const first = breaks.getByRole('checkbox', { name: /^Select Alex 09:00/ }); await first.waitFor();
  await page.waitForFunction(() => document.querySelector('#schedule-date')?.disabled === false);
  await first.check(); await breaks.getByRole('checkbox', { name: /^Select Alex 09:30/ }).check();
  await breaks.getByRole('button', { name: 'Reopen selected times', exact: true }).click();
  await breaks.getByRole('button', { name: 'Apply schedule change', exact: true }).click();
  await breaks.getByRole('status').filter({ hasText: 'Saved 2 slot changes' }).waitFor();
  assert.equal(await available(), 3);
  const staffPage = await (await browser.newContext()).newPage(); await login(staffPage, users[1]);
  assert.equal(await panel(staffPage).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: reviewed dated hours/closures, durable retry, customer availability, explicit lift/reopen, STAFF read-only and mobile layout.');
} finally {
  await browser.close();
  try { await db.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany({ where: { businessId: business.id } }); await tx.customerSession.deleteMany({ where: { businessId: business.id } });
    await tx.scheduleClosure.deleteMany({ where: { businessId: business.id } }); await tx.availabilitySlot.deleteMany({ where: { businessId: business.id } });
    await tx.service.deleteMany({ where: { businessId: business.id } }); await tx.staff.deleteMany({ where: { businessId: business.id } });
    await tx.businessMembership.deleteMany({ where: { businessId: business.id } }); await tx.business.delete({ where: { id: business.id } });
    await tx.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  }); } finally { await db.$disconnect(); }
}
