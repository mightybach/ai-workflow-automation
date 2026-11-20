import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { ChannelModel, Options } from 'amqplib';
import { RabbitMqPublisher } from './rabbitmq-publisher.js';
import { PublishFailure } from './outbox-publisher.js';
import { publisherConfig, workerQueue } from './publisher-config.js';

const url = 'amqp://synthetic:synthetic@127.0.0.1:5672';
const event = { eventId: randomUUID(), businessId: randomUUID(), bookingId: randomUUID(), previousBookingId: null,
  schemaVersion: 1 as const, deliveryMode: 'MOCK' as const, eventType: 'BOOKING_CONFIRMED' as const,
  occurredAt: '2030-01-01T00:00:00.000Z', traceId: 'synthetic-transport' };

test('broker confirms, negative confirms, mandatory returns, closure and deadline have distinct safe outcomes', async () => {
  for (const mode of ['ack', 'nack', 'return', 'close', 'timeout'] as const) {
    let sent = 0; let closed = 0;
    const channel = Object.assign(new EventEmitter(), {
      assertQueue: async () => ({}),
      sendToQueue: (_queue: string, body: Buffer, options: Options.Publish, callback: (error: Error | null) => void) => {
        sent++; assert.equal(options.messageId, event.eventId); assert.equal(options.persistent, true); assert.equal(options.mandatory, true);
        assert.deepEqual(JSON.parse(body.toString()), event);
        queueMicrotask(() => {
          if (mode === 'return') channel.emit('return', {});
          if (mode === 'close') channel.emit('close');
          if (mode !== 'timeout' && mode !== 'close') callback(mode === 'nack' ? new Error('Synthetic nack') : null);
        });
        return false; // Backpressure is not a nack.
      },
    });
    const connection = Object.assign(new EventEmitter(), { createConfirmChannel: async () => channel, close: async () => { closed++; } });
    const publisher = new RabbitMqPublisher({ url, timeoutMs: 30, connector: async () => connection as unknown as ChannelModel });
    const keepAlive = setInterval(() => {}, 50);
    try {
      if (mode === 'ack') await publisher.publish(event);
      else await assert.rejects(publisher.publish(event), (error: unknown) => error instanceof PublishFailure && error.code ===
        ({ nack: 'BROKER_NACK', return: 'UNROUTABLE', close: 'BROKER_UNAVAILABLE', timeout: 'BROKER_TIMEOUT' } as const)[mode]);
      assert.equal(sent, 1); assert.equal(closed, 1);
    } finally { clearInterval(keepAlive); }
  }
});
test('publisher shutdown cannot send a message and invalid envelopes cannot contact the broker', async () => {
  let sent = false;
  const connection = Object.assign(new EventEmitter(), { createConfirmChannel: async () => { sent = true; throw new Error('Unexpected send'); }, close: async () => {} });
  const publisher = new RabbitMqPublisher({ url, connector: async () => connection as unknown as ChannelModel });
  const stop = new AbortController(); stop.abort();
  await assert.rejects(publisher.publish(event, stop.signal), (error: unknown) => error instanceof PublishFailure && error.code === 'PUBLISHER_STOPPED');
  assert.equal(sent, false);
  await assert.rejects(publisher.publish({ ...event, deliveryMode: 'EMAIL' } as unknown as typeof event), (error: unknown) => error instanceof PublishFailure && error.code === 'INVALID_EVENT');
});
test('automation is opt-in, local-only and test queues cannot redirect the demo worker', () => {
  assert.deepEqual(publisherConfig({}), { enabled: false });
  assert.throws(() => publisherConfig({ OUTBOX_PUBLISHER_ENABLED: 'true', DATABASE_URL: 'postgresql://localhost/flowpilot_test', RABBITMQ_URL: url }));
  assert.throws(() => new RabbitMqPublisher({ url: 'amqp://synthetic:synthetic@remote.invalid' }));
  const queue = `flowpilot.mock.notifications.v1.test-${randomUUID()}`;
  assert.throws(() => workerQueue({ TEST_NOTIFICATION_QUEUE: queue }, url));
  assert.equal(workerQueue({ TEST_NOTIFICATION_QUEUE: queue }, url + '/flowpilot_test'), queue);
});
