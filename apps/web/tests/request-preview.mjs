// Start pnpm dev before running pnpm --filter @flowpilot/web test:ui.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

const baseUrl = process.env.FLOWPILOT_URL || 'http://127.0.0.1:5173/';
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1000) });
    if (response.ok) { ready = true; break; }
  } catch { /* Development server may still be starting. */ }
  await delay(500);
}
assert.equal(ready, true, 'Start pnpm dev before running the UI check.');

const browser = await chromium.launch({
  headless: true,
  ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}),
});
const page = await browser.newPage();
const pageErrors = [];
const writes = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('request', (request) => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
try {
  await page.goto(baseUrl);
  await page.getByText('No drafts yet. Create a synthetic request to try the preview.').waitFor();
  await page.getByRole('button', { name: 'New draft', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('   ');
  await page.getByLabel('Request message', { exact: true }).fill('Synthetic text');
  await page.getByRole('button', { name: 'Create draft', exact: true }).click();
  await page.getByText('Enter a title and message.', { exact: true }).waitFor();
  await page.getByLabel('Title', { exact: true }).fill('Synthetic refund');
  await page.getByRole('button', { name: 'Create draft', exact: true }).click();
  await page.getByText('Draft created.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('row').count(), 2);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'View Synthetic refund', exact: true }).click();
  await page.getByRole('heading', { name: 'Draft details', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit Synthetic refund', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Updated synthetic refund');
  await page.getByLabel('Request message', { exact: true }).fill('<script>throw new Error("unsafe")</script>');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Draft updated.', { exact: true }).waitFor();
  assert.equal(await page.locator('dd').last().textContent(), '<script>throw new Error("unsafe")</script>');
  await page.getByRole('button', { name: 'Delete Updated synthetic refund', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Keep draft', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: 'Delete Updated synthetic refund', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Delete Updated synthetic refund', exact: true }).click();
  await page.getByRole('button', { name: 'Delete draft', exact: true }).click();
  await page.getByText('Draft deleted.', { exact: true }).waitFor();
  await page.getByText('No drafts yet. Create a synthetic request to try the preview.').waitFor();

  for (let i = 1; i <= 6; i++) {
    await page.getByRole('button', { name: 'New draft', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Draft ' + i);
    await page.getByLabel('Request message', { exact: true }).fill('Synthetic message ' + i);
    await page.getByRole('button', { name: 'Create draft', exact: true }).click();
    await page.getByRole('button', { name: 'View Draft 1', exact: true }).waitFor();
  }
  assert.equal(await page.getByRole('row').count(), 6);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'View Draft 6', exact: true }).waitFor();
  await page.getByLabel('Search drafts', { exact: true }).fill('message 2');
  await page.getByRole('button', { name: 'View Draft 2', exact: true }).waitFor();
  assert.equal(await page.getByRole('row').count(), 2);
  await page.getByLabel('Search drafts', { exact: true }).fill('no-such-draft');
  await page.getByText('No drafts match your search.', { exact: true }).waitFor();
  await page.getByLabel('Search drafts', { exact: true }).fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.FLOWPILOT_SCREENSHOT) await page.screenshot({ path: process.env.FLOWPILOT_SCREENSHOT, fullPage: true });
  await page.reload();
  await page.getByText('No drafts yet. Create a synthetic request to try the preview.').waitFor();
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(writes, [], 'Draft CRUD must not write to backend services.');
  console.log('PASS: create/read/update/delete, validation, escaped text, cancel/Escape, search, pagination, mobile width, and reset on reload.');
} finally { await browser.close(); }

