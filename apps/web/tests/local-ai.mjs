import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createDatabaseClient, addCalendarDays, businessDate, localBusinessInstant } from '../../../packages/db/dist/index.js';

// Opt-in real-provider check: run against the local API with AI_PROVIDER=ollama.
// No response stubs or booking writes. Clean only this fixture.
const base = new URL(process.env.FLOWPILOT_URL ?? 'http://127.0.0.1:5173');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Use a local demo URL.');
const database = process.env.DATABASE_URL;
if (!database || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(database).hostname) ||
  !['/flowpilot', '/flowpilot_test'].includes(new URL(database).pathname)) throw new Error('Use a local demo/test database.');
const db = createDatabaseClient(database);
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
let business;
try {
  business = await db.business.create({ data: { slug: 'ai-browser-' + randomUUID(), name: 'Synthetic Local AI Browser' } });
  const service = await db.service.create({ data: { businessId: business.id, slug: 'haircut', name: 'Haircut' } });
  const staff = await db.staff.create({ data: { businessId: business.id, slug: 'alex', displayName: 'Alex' } });
  const fixtureDate = addCalendarDays(businessDate(new Date(), business.timezone), 1);
  const start = localBusinessInstant(fixtureDate, business.timezone, 9);
  await db.availabilitySlot.createMany({ data: [0, 1, 2].map((index) => ({ businessId: business.id, staffId: staff.id,
    startAt: new Date(+start + index * 1800000), endAt: new Date(+start + (index + 1) * 1800000) })) });
  const page = await browser.newPage();
  page.setDefaultTimeout(35000);
  const errors = [];
  const writes = [];
  const availabilityReads = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/v1\/customer\/(bookings|booking-proposals)$/.test(new URL(request.url()).pathname)) writes.push(request.url());
    if (new URL(request.url()).pathname === '/api/v1/customer/availability') availabilityReads.push(new URL(request.url()));
  });
  await page.goto(new URL('/book', base).href);
  await page.getByLabel('Business', { exact: true }).fill(business.slug);
  await page.getByRole('button', { name: 'Start booking', exact: true }).click();
  await page.getByText(business.name, { exact: true }).waitFor();
  const chat = async (message, checkTyping = false) => {
    await page.getByLabel('Message', { exact: true }).fill(message);
    const response = page.waitForResponse((response) => response.url().endsWith('/api/v1/customer/chat/messages') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    if (checkTyping) await page.getByRole('status').filter({ hasText: 'Assistant is typing' }).waitFor();
    const result = await response;
    assert.equal(result.status(), 200, 'Local AI must respond successfully; check memory/runtime if fallback occurs.');
    const body = await result.json();
    assert.equal(body.provider, 'ollama-v1', 'Restart the local API with AI_PROVIDER=ollama.');
    await page.waitForFunction(() => document.querySelector('#booking-message')?.disabled === false);
    return body;
  };
  const result = await chat('Haircut tomoral for 60 minuit with Alex', true);
  assert.deepEqual(result.needsClarification, []);
  const date = addCalendarDays(businessDate(new Date(result.referenceTime), business.timezone), 1);
  assert.deepEqual(result.selection, { serviceId: service.id, staffId: staff.id, date, durationMinutes: 60 });
  assert.match(result.message, /tomoral → tomorrow/);
  assert.match(result.message, /minuit → minutes/);
  const followUp = await chat('tomorrrow');
  assert.deepEqual(followUp.selection, result.selection, 'Date-only typo follow-up retains Haircut, Alex and 60 minutes.');
  assert.deepEqual(followUp.needsClarification, []);
  assert.match(followUp.message, /tomorrrow → tomorrow/);
  await page.getByLabel('Chat messages').getByText('AI assistant:', { exact: true }).first().waitFor();
  assert.equal(await page.getByLabel('Appointment date (dd-mm-yyyy)').inputValue(), date.split('-').reverse().join('-'));
  assert.equal(await page.getByLabel('Duration', { exact: true }).inputValue(), '60');
  assert.equal(await page.getByLabel('Service', { exact: true }).inputValue(), service.id);
  assert.equal(await page.getByLabel('Preferred staff').inputValue(), staff.id, 'Alex must fill automatically without an apply click.');
  assert.equal(await page.getByRole('button', { name: 'Confirm booking', exact: true }).count(), 0, 'No confirmation action before selecting an actual time.');
  const availability = await chat('what is the available time?');
  assert.deepEqual(availability.needsClarification, []);
  await page.getByLabel('Available appointments', { exact: true }).getByText('2 available starts', { exact: false }).waitFor();
  await page.getByLabel('Chat messages').getByText(/I found 2 available starts/).last().waitFor();
  assert.equal(await page.getByRole('button', { name: /^Select Alex/ }).count(), 2);
  assert.ok(availabilityReads.length);
  for (const url of availabilityReads) {
    assert.equal(url.searchParams.get('staffId'), staff.id);
    assert.equal(url.searchParams.get('durationMinutes'), '60');
    assert.equal(url.searchParams.get('date'), date);
  }
  assert.equal(await page.getByRole('status').filter({ hasText: 'typing' }).count(), 0);
  if (process.env.FLOWPILOT_AI_SCREENSHOT) {
    await page.screenshot({ path: process.env.FLOWPILOT_AI_SCREENSHOT + '-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: process.env.FLOWPILOT_AI_SCREENSHOT + '-mobile.png', fullPage: true });
  }
  const consent = await chat('yes confirm');
  assert.ok(consent.needsClarification.length);
  assert.equal(await page.getByLabel('Preferred staff').inputValue(), staff.id, 'Chat consent must not change the form.');
  assert.equal(writes.length, 0);
  assert.equal(await db.booking.count({ where: { businessId: business.id } }), 0);
  assert.equal(await db.bookingProposal.count({ where: { businessId: business.id } }), 0);
  assert.equal(await db.bookingAction.count({ where: { businessId: business.id } }), 0);
  assert.equal(await db.auditEvent.count({ where: { businessId: business.id } }), 0);
  await page.getByRole('button', { name: 'End customer session' }).click();
  await page.getByRole('button', { name: 'Start booking', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: real AI typing feedback, disclosed typo correction, automatic Alex/date/duration fill, contextual database availability, chat consent rejected, no proposal/booking effects.');
} finally {
  await browser.close();
  try {
    if (business) {
      await db.customerSession.deleteMany({ where: { businessId: business.id } });
      await db.availabilitySlot.deleteMany({ where: { businessId: business.id } });
      await db.staff.deleteMany({ where: { businessId: business.id } });
      await db.service.deleteMany({ where: { businessId: business.id } });
      await db.business.delete({ where: { id: business.id } });
    }
  } finally { await db.$disconnect(); }
}
