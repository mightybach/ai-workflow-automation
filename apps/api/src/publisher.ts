import { setTimeout as delay } from 'node:timers/promises';
import { createDatabaseClient } from '@flowpilot/db';
import { publisherConfig } from './publisher-config.js';
import { RabbitMqPublisher } from './rabbitmq-publisher.js';
import { publishOutboxBatch } from './outbox-publisher.js';

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
try {
  if (process.argv.slice(2).some((value) => value !== '--once')) throw new Error('Unknown publisher option.');
  const config = publisherConfig(process.env);
  if (!config.enabled) console.log(JSON.stringify({ service: 'outbox-publisher', status: 'disabled' }));
  else {
    const db = createDatabaseClient(config.databaseUrl); const publisher = new RabbitMqPublisher({ url: config.brokerUrl });
    try {
      do {
        try {
          const result = await publishOutboxBatch(db, publisher, { signal: stop.signal });
          console.log(JSON.stringify({ service: 'outbox-publisher', ...result }));
        } catch {
          if (!stop.signal.aborted) console.error(JSON.stringify({ service: 'outbox-publisher', error: 'PUBLISHER_UNAVAILABLE' }));
          if (process.argv.includes('--once')) process.exitCode = 1;
        }
        if (process.argv.includes('--once') || stop.signal.aborted) break;
        try { await delay(1000, undefined, { signal: stop.signal }); } catch { break; }
      } while (!stop.signal.aborted);
    } finally { await db.$disconnect(); }
  }
} catch { console.error(JSON.stringify({ service: 'outbox-publisher', error: 'PUBLISHER_FAILED' })); process.exitCode = 1; }
