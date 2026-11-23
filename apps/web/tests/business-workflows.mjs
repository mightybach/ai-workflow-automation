import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createDatabaseClient, hashPassword, businessDate, addCalendarDays, localBusinessInstant } from '../../../packages/db/dist/index.js';
import { workflowBatch } from '../../api/dist/workflow-executor.js';

const base = new URL(process.env.FLOWPILOT_URL ?? 'http://127.0.0.1:5173'); const database = process.env.DATABASE_URL;
if (!database || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(database).hostname) || !['/flowpilot', '/flowpilot_test'].includes(new URL(database).pathname) || base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Use local synthetic endpoints.');
const db = createDatabaseClient(database); const tag = randomUUID(); const password = 'workflow-browser-' + tag;
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const business = await db.business.create({ data: { slug: 'workflow-browser-' + tag, name: 'Synthetic Workflow Browser' } }); const users = [];
try {
  const hash = await hashPassword(password);
  for (const [index, role] of ['OWNER', 'STAFF'].entries()) {
    const user = await db.user.create({ data: { email: `workflow-browser-${tag}-${index}@example.test`, role: index ? 'ADMIN' : 'CLIENT', passwordHash: hash } }); users.push(user);
    await db.businessMembership.create({ data: { businessId: business.id, userId: user.id, role } });
  }
  const owner = await browser.newContext(); const page = await owner.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const panel = (target) => target.getByRole('region', { name: 'Business workflows', exact: true });
  const login = async (target, user) => { await target.goto(base.href); await target.getByLabel('Email', { exact: true }).fill(user.email); await target.getByLabel('Password', { exact: true }).fill(password); await target.getByRole('button', { name: 'Sign in', exact: true }).click(); await target.getByRole('heading', { name: business.name, exact: true }).waitFor(); await target.getByRole('link', { name: 'Workflows', exact: true }).click(); await panel(target).getByText('Appointment preparation', { exact: true }).waitFor(); };
  await login(page, users[0]);
  const preparation = () => panel(page).getByRole('button', { name: 'Review enable appointment preparation', exact: true });
  await preparation().click(); await panel(page).getByRole('button', { name: 'Keep current state', exact: true }).click(); assert.equal(await db.businessWorkflowDefinition.count({ where: { businessId: business.id } }), 0);
  const writes = []; let drop = true;
  await page.route('**/api/v1/admin/workflows/*', async (route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    writes.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    if (drop) { drop = false; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); } else await route.continue();
  });
  await preparation().click(); await panel(page).getByRole('button', { name: 'Confirm workflow action', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Retry same action', exact: true }).waitFor(); await page.reload();
  await panel(page).getByRole('button', { name: 'Retry same action', exact: true }).waitFor(); assert.equal(writes.length, 1);
  await panel(page).getByRole('button', { name: 'Retry same action', exact: true }).click(); await panel(page).getByRole('status').filter({ hasText: 'Action saved' }).waitFor();
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]); await page.unroute('**/api/v1/admin/workflows/*');
  const staff = await db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } }); const service = await db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } });
  const date = addCalendarDays(businessDate(new Date(), business.timezone), 1); const start = localBusinessInstant(date, business.timezone, 10);
  const slot = await db.availabilitySlot.create({ data: { businessId: business.id, staffId: staff.id, startAt: start, endAt: new Date(+start + 1800000) } });
  const customer = await browser.newContext(); const headers = { Origin: base.origin, 'X-Flowpilot-Client': 'web' };
  assert.equal((await customer.request.post(new URL('/api/v1/customer/sessions', base).href, { headers, data: { businessSlug: business.slug } })).status(), 201);
  const selected = await customer.request.post(new URL('/api/v1/customer/booking-proposals', base).href, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { slotId: slot.id, serviceId: service.id, durationMinutes: 30 } }); assert.equal(selected.status(), 201);
  const confirmed = await customer.request.post(new URL('/api/v1/customer/bookings', base).href, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { proposalId: (await selected.json()).id, customer: { name: 'Synthetic', email: 'demo@example.test' } } }); assert.equal(confirmed.status(), 201); const booking = await confirmed.json();
  await workflowBatch(db, { businessId: business.id }); await panel(page).getByRole('button', { name: 'Refresh workflows', exact: true }).click();
  const taskCard = () => panel(page).getByRole('article', { name: 'Appointment preparation ' + booking.reference, exact: true });
  await panel(page).getByLabel('Task date (dd-mm-yyyy, empty for all)', { exact: true }).fill('31-02-2030');
  await panel(page).getByRole('alert').filter({ hasText: 'Enter the task date' }).waitFor();
  await panel(page).getByLabel('Task date (dd-mm-yyyy, empty for all)', { exact: true }).fill(date.split('-').reverse().join('-'));
  await taskCard().getByRole('button', { name: 'Review completion', exact: true }).click();
  assert.equal((await db.businessTask.findFirstOrThrow({ where: { businessId: business.id } })).status, 'OPEN');
  await panel(page).getByRole('button', { name: 'Keep current state', exact: true }).click();
  let loseComplete = true; const completions = [];
  await page.route('**/api/v1/admin/tasks/*/complete', async (route) => {
    completions.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    if (loseComplete) { loseComplete = false; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); } else await route.continue();
  });
  await taskCard().getByRole('button', { name: 'Review completion', exact: true }).click(); await panel(page).getByRole('button', { name: 'Confirm workflow action', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Retry same action', exact: true }).waitFor(); await page.reload(); await panel(page).getByRole('button', { name: 'Retry same action', exact: true }).waitFor(); assert.equal(completions.length, 1);
  await panel(page).getByRole('button', { name: 'Retry same action', exact: true }).click(); await panel(page).getByRole('status').filter({ hasText: 'Action saved' }).waitFor(); assert.deepEqual(completions[0], completions[1]);
  await panel(page).getByRole('button', { name: 'Review enable arrival enquiry follow-up', exact: true }).click(); await panel(page).getByRole('button', { name: 'Confirm workflow action', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Review disable arrival enquiry follow-up', exact: true }).waitFor();
  await panel(page).getByLabel('Enquiry appointment date (dd-mm-yyyy)', { exact: true }).fill(date.split('-').reverse().join('-'));
  await panel(page).getByLabel('Enquiry booking', { exact: true }).selectOption(booking.id);
  await panel(page).getByRole('button', { name: 'Review arrival enquiry', exact: true }).click(); await panel(page).getByRole('button', { name: 'Confirm workflow action', exact: true }).click(); await panel(page).getByRole('status').filter({ hasText: 'Action saved' }).waitFor();
  await workflowBatch(db, { businessId: business.id });
  const staffContext = await browser.newContext(); const staffPage = await staffContext.newPage(); await login(staffPage, users[1]);
  assert.equal(await panel(staffPage).getByRole('button', { name: /Review enable|Review disable/ }).count(), 0);
  const followUp = panel(staffPage).getByRole('article', { name: 'Arrival enquiry follow-up ' + booking.reference, exact: true });
  await followUp.getByRole('button', { name: 'Review completion', exact: true }).click(); await panel(staffPage).getByRole('button', { name: 'Confirm workflow action', exact: true }).click(); await panel(staffPage).getByRole('status').filter({ hasText: 'Action saved' }).waitFor();
  const beforeCancel = await db.businessTask.findMany({ where: { businessId: business.id } }); assert.equal(beforeCancel.length, 2); assert.ok(beforeCancel.every((task) => task.status === 'COMPLETED'));
  const cancelled = await customer.request.post(new URL(`/api/v1/customer/bookings/${booking.id}/cancel`, base).href, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: {} }); assert.equal(cancelled.status(), 200);
  await panel(staffPage).getByLabel('Task status', { exact: true }).selectOption(''); await panel(staffPage).getByRole('button', { name: 'Refresh workflows', exact: true }).click(); await panel(staffPage).getByText(/Invalidated: BOOKING_CANCELLED/).first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
  console.log('PASS: two workflow scenarios, explicit review, durable policy/task lost-response reload retry, OWNER-only policy, STAFF completion, lifecycle history and mobile layout.');
} finally {
  await browser.close();
  try { await db.$transaction(async (tx) => {
    const where = { businessId: business.id }; await tx.businessWorkflowAction.deleteMany({ where }); await tx.businessTask.deleteMany({ where }); await tx.businessWorkflowRun.deleteMany({ where }); await tx.businessWorkflowDefinition.deleteMany({ where });
    await tx.notificationOutbox.deleteMany({ where }); await tx.auditEvent.deleteMany({ where }); await tx.bookingAction.deleteMany({ where }); await tx.bookingSlot.deleteMany({ where }); await tx.booking.deleteMany({ where }); await tx.bookingProposal.deleteMany({ where }); await tx.customerSession.deleteMany({ where });
    await tx.availabilitySlot.deleteMany({ where }); await tx.staff.deleteMany({ where }); await tx.service.deleteMany({ where }); await tx.session.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } }); await tx.businessMembership.deleteMany({ where }); await tx.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } }); await tx.business.delete({ where: { id: business.id } });
  }); } finally { await db.$disconnect(); }
}
