import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { addCalendarDays, businessDate, createDatabaseClient, hashPassword, localBusinessInstant } from '../../../packages/db/dist/index.js';

const base = new URL(process.env.FLOWPILOT_URL ?? 'http://127.0.0.1:5173');
const database = process.env.DATABASE_URL;
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) || !['/flowpilot', '/flowpilot_test'].includes(new URL(database).pathname) ||
  base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Use local synthetic demo/test endpoints.');
const db = createDatabaseClient(database);
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const tag = randomUUID(); const password = 'synthetic-schedule-' + tag;
const business = await db.business.create({ data: { slug: 'schedule-browser-' + tag, name: 'Synthetic Schedule Browser' } });
const users = [];
try {
  const passwordHash = await hashPassword(password);
  for (const [index, role] of ['OWNER', 'STAFF'].entries()) {
    const user = await db.user.create({ data: { email: `schedule-browser-${tag}-${index}@example.test`, role: index ? 'ADMIN' : 'CLIENT', passwordHash } });
    users.push(user); await db.businessMembership.create({ data: { businessId: business.id, userId: user.id, role } });
  }
  const staff = await Promise.all(['Alex', 'Jamie'].map((name) => db.staff.create({ data: { businessId: business.id, slug: name.toLowerCase(), displayName: name } })));
  const service = await db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } });
  const date = addCalendarDays(businessDate(new Date(), business.timezone), 1); const display = date.split('-').reverse().join('-');
  const start = localBusinessInstant(date, business.timezone, 9); const slots = [];
  for (const [person, staffMember] of staff.entries()) for (let n = 0; n < 3; n++) slots.push(await db.availabilitySlot.create({ data: {
    businessId: business.id, staffId: staffMember.id, startAt: new Date(+start + n * 1800000), endAt: new Date(+start + (n + 1) * 1800000),
    state: person === 0 && n === 0 ? 'RESERVED' : 'AVAILABLE',
  } }));
  const ownerContext = await browser.newContext(); const page = await ownerContext.newPage(); const errors = []; const writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const panel = (target) => target.getByRole('region', { name: 'Breaks and closures', exact: true });
  const box = (target, name = 'Alex', time = '09:30') => panel(target).getByRole('checkbox', { name: new RegExp(`^Select ${name} ${time}`) });
  async function login(target, user) {
    await target.goto(base.href); await target.getByLabel('Email', { exact: true }).fill(user.email); await target.getByLabel('Password', { exact: true }).fill(password);
    await target.getByRole('button', { name: 'Sign in', exact: true }).click(); await target.getByRole('heading', { name: business.name, exact: true }).waitFor();
  }
  async function load(target) {
    await target.getByLabel('Schedule date (dd-mm-yyyy)', { exact: true }).fill(display); await box(target).waitFor();
    await target.waitForFunction(() => document.querySelector('#schedule-date')?.disabled === false);
  }
  await login(page, users[0]); await load(page);
  assert.equal(await box(page, 'Alex', '09:00').isDisabled(), true);
  const stale = await ownerContext.newPage(); await stale.goto(base.href); await load(stale);
  const customer = await browser.newContext(); const requestHeaders = { Origin: base.origin, 'X-Flowpilot-Client': 'web' };
  assert.equal((await customer.request.post(new URL('/api/v1/customer/sessions', base).href, { headers: requestHeaders, data: { businessSlug: business.slug } })).status(), 201);
  const available = async () => (await (await customer.request.get(new URL(`/api/v1/customer/availability?date=${date}&staffId=${staff[0].id}&serviceId=${service.id}&durationMinutes=60`, base).href)).json()).pagination.total;
  assert.equal(await available(), 1);
  let drop = true;
  await page.route('**/api/v1/admin/schedule', async (route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    writes.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    if (drop) { drop = false; const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort('failed'); }
    else await route.continue();
  });
  await box(page).check(); await panel(page).getByRole('button', { name: 'Block selected times', exact: true }).click();
  await panel(page).getByRole('heading', { name: 'Review schedule change', exact: true }).waitFor();
  assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slots[1].id } })).state, 'AVAILABLE', 'Review must not mutate inventory.');
  await panel(page).getByRole('button', { name: 'Apply schedule change', exact: true }).click();
  await panel(page).getByRole('alert').filter({ hasText: 'Retry the same schedule change' }).waitFor();
  assert.equal(await available(), 0);
  await panel(page).getByRole('button', { name: 'Retry same schedule change', exact: true }).click();
  await panel(page).getByRole('status').filter({ hasText: 'Saved 1 slot changes' }).waitFor();
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.equal(await db.auditEvent.count({ where: { businessId: business.id } }), 1);
  await page.unroute('**/api/v1/admin/schedule');
  await box(page).check(); await panel(page).getByRole('button', { name: 'Reopen selected times', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Apply schedule change', exact: true }).click();
  await panel(page).getByRole('status').filter({ hasText: 'Saved 1 slot changes' }).waitFor();
  assert.equal(await available(), 1);
  await box(stale, 'Jamie').check(); await panel(stale).getByRole('button', { name: 'Block selected times', exact: true }).click();
  await panel(stale).getByRole('button', { name: 'Apply schedule change', exact: true }).click();
  await panel(stale).getByRole('alert').filter({ hasText: 'schedule changed' }).waitFor();
  assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slots[4].id } })).state, 'AVAILABLE');
  await panel(stale).getByRole('button', { name: 'Refresh schedule', exact: true }).click();
  await stale.waitForFunction(() => document.querySelector('#schedule-date')?.disabled === false);
  await box(stale, 'Jamie').check(); await panel(stale).getByRole('button', { name: 'Block selected times', exact: true }).click();
  await panel(stale).getByRole('button', { name: 'Apply schedule change', exact: true }).click();
  await panel(stale).getByRole('status').filter({ hasText: 'Saved 1 slot changes' }).waitFor();
  assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slots[0].id } })).state, 'RESERVED');
  const staffContext = await browser.newContext(); const staffPage = await staffContext.newPage(); await login(staffPage, users[1]);
  assert.equal(await panel(staffPage).count(), 0); await staffPage.getByRole('heading', { name: 'Slot inventory', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.FLOWPILOT_SCHEDULE_SCREENSHOT) await page.screenshot({ path: process.env.FLOWPILOT_SCHEDULE_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: reviewed owner breaks/reopening, actual duration-aware customer availability, reserved protection, durable lost-response retry, stale edits, STAFF read-only and mobile layout.');
} finally {
  await browser.close();
  try { await db.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany({ where: { businessId: business.id } }); await tx.customerSession.deleteMany({ where: { businessId: business.id } });
    await tx.availabilitySlot.deleteMany({ where: { businessId: business.id } }); await tx.service.deleteMany({ where: { businessId: business.id } });
    await tx.staff.deleteMany({ where: { businessId: business.id } }); await tx.businessMembership.deleteMany({ where: { businessId: business.id } });
    await tx.business.delete({ where: { id: business.id } }); await tx.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  }); } finally { await db.$disconnect(); }
}
