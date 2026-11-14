import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.FLOWPILOT_URL || 'http://127.0.0.1:5173/';
const password = process.env.DEMO_PASSWORD;
if (!password) throw new Error('DEMO_PASSWORD is required; create .env and run pnpm db:seed.');
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if ((await fetch(new URL('/api/v1/health/ready', baseUrl), { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; }
  } catch { /* Starting. */ }
  await delay(500);
}
assert.equal(ready, true, 'Start pnpm dev before running the browser check.');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}),
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const tag = 'Synthetic-browser-' + randomUUID();
let requestId = '';
let runId = '';
async function login(email) {
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Requests', exact: true }).waitFor();
}
try {
  await page.goto(baseUrl);
  await login('client@flowpilot.test');
  await page.getByLabel('Request message', { exact: true }).fill('   ');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await page.getByText('Enter a nonblank message of up to 10,000 characters.', { exact: true }).waitFor();
  await page.getByLabel('Request message', { exact: true }).fill(tag + ' <script>throw new Error("unsafe")</script>');

  // Commit the first POST but drop its response. Retrying must reuse the key.
  let dropResponse = true;
  await page.route('**/api/v1/requests', async (route) => {
    if (route.request().method() === 'POST' && dropResponse) {
      dropResponse = false;
      const response = await route.fetch();
      assert.equal(response.status(), 202);
      const created = await response.json();
      requestId = created.requestId; runId = created.workflowRunId;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await page.getByText(/Retry unchanged text to reuse the same submission key/).waitFor();
  const retried = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/requests'));
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  assert.equal((await (await retried).json()).requestId, requestId);
  await page.getByRole('heading', { name: 'Request details', exact: true }).waitFor();
  assert.equal(await page.locator('dd').filter({ hasText: '<script>' }).textContent(), tag + ' <script>throw new Error("unsafe")</script>');
  await page.getByRole('button', { name: 'View workflow ' + runId, exact: true }).click();
  await page.getByRole('heading', { name: 'Workflow details', exact: true }).waitFor();
  await page.getByLabel('Search requests', { exact: true }).fill(tag);
  await page.getByRole('button', { name: 'View request ' + requestId, exact: true }).waitFor();
  assert.equal(await page.getByRole('row').count(), 2);
  await page.getByLabel('Status', { exact: true }).selectOption('PENDING');
  await page.getByRole('button', { name: 'View request ' + requestId, exact: true }).waitFor();
  await page.getByLabel('Category', { exact: true }).selectOption('REFUND_REQUEST');
  await page.getByText('No requests found.', { exact: true }).waitFor();
  await page.getByLabel('Category', { exact: true }).selectOption('');
  await page.getByRole('button', { name: 'View request ' + requestId, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Edit |^Delete / }).count(), 0);

  await page.reload();
  await page.getByRole('heading', { name: 'Requests', exact: true }).waitFor();
  await page.getByLabel('Search requests', { exact: true }).fill(tag);
  await page.getByRole('button', { name: 'View request ' + requestId, exact: true }).click();
  await page.getByRole('heading', { name: 'Request details', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.FLOWPILOT_SCREENSHOT) await page.screenshot({ path: process.env.FLOWPILOT_SCREENSHOT, fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Requests', exact: true }).count(), 0);

  await login('reviewer@flowpilot.test');
  await page.getByText('Showing requests from all demo users.', { exact: true }).waitFor();
  await page.getByLabel('Search requests', { exact: true }).fill(tag);
  await page.getByRole('button', { name: 'View request ' + requestId, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: sign-in, validation, lost-response idempotent retry, saved detail/workflow reads, filters, reload/session persistence, mobile width, logout and reviewer access.');
  console.log('Created one synthetic sample request: ' + requestId);
} catch (error) {
  console.error('Browser alerts:', await page.getByRole('alert').allTextContents());
  if (process.env.FLOWPILOT_SCREENSHOT) await page.screenshot({ path: process.env.FLOWPILOT_SCREENSHOT, fullPage: true });
  throw error;
} finally { await browser.close(); }

