import { connect } from 'amqplib';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabaseClient } from '@flowpilot/db';
import { publisherConfig, workerQueue } from './publisher-config.js';
import { handleNotificationDelivery } from './notification-delivery.js';

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
try {
  if (process.argv.slice(2).some((arg) => arg !== '--once')) throw new Error('Unknown worker option.');
  const config = publisherConfig({ ...process.env, OUTBOX_PUBLISHER_ENABLED: process.env.NOTIFICATION_WORKER_ENABLED });
  if (!config.enabled) console.log(JSON.stringify({ service: 'mock-worker', status: 'disabled' }));
  else {
    const db = createDatabaseClient(config.databaseUrl);
    const queue = workerQueue(process.env, config.brokerUrl);
    try {
      do {
        let connection: Awaited<ReturnType<typeof connect>> | undefined;
        const socketStop = new AbortController();
        try {
          const socketOptions = { timeout: 3000, noDelay: true, signal: AbortSignal.any([stop.signal, socketStop.signal]) };
          connection = await connect(`${config.brokerUrl}?heartbeat=5`, socketOptions);
          connection.on('error', () => {});
          const channel = await connection.createChannel(); channel.on('error', () => {});
          await channel.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
          // Serial pull: at most one unacknowledged message per worker.
          do {
            // Do not repeatedly take/requeue messages during a known DB outage.
            await db.$queryRaw`SELECT 1`;
            const message = await channel.get(queue, { noAck: false });
            if (message) {
              try {
                const result = await handleNotificationDelivery(db, message);
                channel.ack(message); // Only after the receipt transaction commits.
                console.log(JSON.stringify({ service: 'mock-worker', outcome: result.outcome,
                  ...('duplicate' in result ? { duplicate: result.duplicate } : { reason: result.reason }) }));
              } catch (error) {
                channel.nack(message, false, true); throw error;
              }
            }
            if (!message && process.argv.includes('--once')) console.log(JSON.stringify({ service: 'mock-worker', status: 'idle' }));
            if (process.argv.includes('--once')) {
              // Channel close is a protocol barrier for the preceding ACK.
              // Closing the whole connection immediately can race its handling.
              await channel.close(); break;
            }
            if (stop.signal.aborted) break;
            if (!message) await delay(1000, undefined, { signal: stop.signal });
          } while (!stop.signal.aborted);
        } catch {
          if (!stop.signal.aborted) {
            console.error(JSON.stringify({ service: 'mock-worker', error: 'WORKER_UNAVAILABLE' }));
            if (process.argv.includes('--once')) process.exitCode = 1;
          }
        } finally {
          if (connection) {
            let closeTimer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([connection.close().catch(() => {}), new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 500); })]);
            if (closeTimer) clearTimeout(closeTimer);
          }
          socketStop.abort();
        }
        if (process.argv.includes('--once') || stop.signal.aborted) break;
        try { await delay(1000, undefined, { signal: stop.signal }); } catch { break; }
      } while (!stop.signal.aborted);
    } finally { await db.$disconnect(); }
  }
} catch { console.error(JSON.stringify({ service: 'mock-worker', error: 'WORKER_FAILED' })); process.exitCode = 1; }
