import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const base = process.env.FLOWPILOT_URL || 'http://127.0.0.1:5173/';
if (!process.env.DEMO_PASSWORD) throw new Error('Seed the demo and set DEMO_PASSWORD.');
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try { if ((await fetch(new URL('/api/v1/health/ready', base), { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* Starting. */ }
  await delay(500);
}
assert.equal(ready, true, 'Start pnpm dev before the browser check.');
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const page = await browser.newPage();
const errors = [];
const businessWrites = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (!['GET', 'HEAD'].includes(request.method()) && /\/api\/v1\/(admin|bookings)/.test(request.url())) businessWrites.push(request.url());
});
async function login(email) {
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
try {
  await page.goto(base);
  await login('owner@flowpilot.test');
  await page.getByRole('heading', { name: 'FlowPilot Demo Salon', exact: true }).waitFor();
  await page.getByText('Synthetic salon · OWNER', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Staff', exact: true }).waitFor();
  await page.getByText('Alex', { exact: true }).first().waitFor();
  await page.getByText('Haircut', { exact: true }).waitFor();
  const dateInput = page.getByLabel('Date', { exact: true });
  let date = process.env.SEED_START_DATE || await dateInput.inputValue();
  const parsed = new Date(date + 'T00:00:00Z');
  while ([0, 6].includes(parsed.getUTCDay())) parsed.setUTCDate(parsed.getUTCDate() + 1);
  date = parsed.toISOString().slice(0, 10);
  await dateInput.fill(date);
  await page.getByRole('table', { name: 'Staff slot inventory', exact: true }).waitFor();
  await page.getByRole('navigation', { name: 'slots pages', exact: true }).getByText(/28 slots/).waitFor();
  await page.getByRole('button', { name: 'Next slots page', exact: true }).click();
  await page.getByText(/Page 2 of 2.*28 slots/).waitFor();
  await page.getByLabel('Staff member', { exact: true }).selectOption({ label: 'Alex' });
  await page.getByText(/Page 1 of 1.*14 slots/).waitFor();
  await page.getByRole('cell', { name: /9:00 am/ }).first().waitFor();
  assert.equal(await page.getByRole('row').count(), 15);
  await page.getByLabel('Inventory state', { exact: true }).selectOption('BLOCKED');
  await page.getByText('No slots for this date and filter.', { exact: true }).waitFor();
  await page.getByLabel('Inventory state', { exact: true }).selectOption('');
  await page.getByRole('table', { name: 'Staff slot inventory', exact: true }).waitFor();
  // API failures are visible and Refresh setup recovers without a page reload.
  let fail = true;
  await page.route('**/api/v1/admin/slots?**', async (route) => {
    if (fail) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_READY', message: 'Synthetic inventory unavailable.', traceId: 'browser-check' }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Refresh setup', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic inventory unavailable.' }).waitFor();
  fail = false;
  await page.getByRole('button', { name: 'Refresh setup', exact: true }).click();
  await page.getByRole('table', { name: 'Staff slot inventory', exact: true }).waitFor();

  await page.reload();
  await page.getByRole('heading', { name: 'FlowPilot Demo Salon', exact: true }).waitFor();
  await dateInput.fill(date);
  await page.getByRole('table', { name: 'Staff slot inventory', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.FLOWPILOT_BOOKING_SCREENSHOT) await page.screenshot({ path: process.env.FLOWPILOT_BOOKING_SCREENSHOT, fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login('staff@flowpilot.test');
  await page.getByText('Synthetic salon · STAFF', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'FlowPilot Demo Salon', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Confirm booking|Create service|Delete staff/ }).count(), 0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login('admin@flowpilot.test');
  await page.getByRole('alert').filter({ hasText: 'no active business access' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'FlowPilot Demo Salon', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  assert.deepEqual(errors, []);
  assert.deepEqual(businessWrites, []);
  console.log('PASS: owner/staff dashboard, business timezone, two employees/services, date/staff/state filters, pagination, empty/error recovery, reload, mobile layout and legacy-admin denial.');
} catch (error) {
  console.error('Browser alerts:', await page.getByRole('alert').allTextContents());
  if (process.env.FLOWPILOT_BOOKING_SCREENSHOT) await page.screenshot({ path: process.env.FLOWPILOT_BOOKING_SCREENSHOT, fullPage: true });
  throw error;
} finally { await browser.close(); }

