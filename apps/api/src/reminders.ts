import { setTimeout as delay } from 'node:timers/promises';
import { createDatabaseClient, DEMO_BUSINESS_SLUG } from '@flowpilot/db';
import { publisherConfig } from './publisher-config.js';
import { scheduleMockReminders, setMockReminderPolicy } from './mock-reminders.js';

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--once', '--enable-demo', '--disable-demo'].includes(arg)) || args.includes('--enable-demo') && args.includes('--disable-demo')) throw new Error('Invalid reminder option.');
  const config = publisherConfig({ ...process.env, OUTBOX_PUBLISHER_ENABLED: process.env.MOCK_REMINDERS_ENABLED });
  if (!config.enabled) console.log(JSON.stringify({ service: 'mock-reminders', status: 'disabled' }));
  else {
    const db = createDatabaseClient(config.databaseUrl);
    try {
      if (args.includes('--enable-demo') || args.includes('--disable-demo')) {
        // Trusted local operator only, fixed synthetic demo business; never an AI tool.
        const business = await db.business.findUniqueOrThrow({ where: { slug: DEMO_BUSINESS_SLUG } });
        await setMockReminderPolicy(db, business.id, args.includes('--enable-demo'));
        console.log(JSON.stringify({ service: 'mock-reminders', status: 'policy-saved' }));
      } else do {
        try { console.log(JSON.stringify({ service: 'mock-reminders', ...await scheduleMockReminders(db) })); }
        catch {
          if (!stop.signal.aborted) console.error(JSON.stringify({ service: 'mock-reminders', error: 'REMINDERS_UNAVAILABLE' }));
          if (args.includes('--once')) process.exitCode = 1;
        }
        if (args.includes('--once') || stop.signal.aborted) break;
        try { await delay(30_000, undefined, { signal: stop.signal }); } catch { break; }
      } while (!stop.signal.aborted);
    } finally { await db.$disconnect(); }
  }
} catch { console.error(JSON.stringify({ service: 'mock-reminders', error: 'REMINDERS_FAILED' })); process.exitCode = 1; }
