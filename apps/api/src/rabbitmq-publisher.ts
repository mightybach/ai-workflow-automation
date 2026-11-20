import { connect, type ChannelModel, type ConfirmChannel, type Options, type SocketOptions } from 'amqplib';
import { BookingNotificationEventSchema, MOCK_NOTIFICATION_QUEUE, type BookingNotificationEvent } from '@flowpilot/contracts';
import { PublishFailure, type EventPublisher } from './outbox-publisher.js';
import { localBrokerUrl } from './publisher-config.js';

type Connector = (url: Options.Connect, options: SocketOptions) => Promise<ChannelModel>;
export class RabbitMqPublisher implements EventPublisher {
  constructor(private readonly options: { url: string; queue?: string; timeoutMs?: number; connector?: Connector }) {
    localBrokerUrl(options.url);
    if (options.queue && !/^flowpilot\.mock\.notifications\.v1(?:\.test-[a-f0-9-]+)?$/.test(options.queue)) throw new Error('Unsupported mock queue name.');
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 20 || options.timeoutMs > 10_000)) throw new Error('Unsupported publisher deadline.');
  }
  async publish(input: BookingNotificationEvent, externalSignal?: AbortSignal): Promise<void> {
    const parsed = BookingNotificationEventSchema.safeParse(input);
    if (!parsed.success) throw new PublishFailure('INVALID_EVENT');
    const event = parsed.data; const queue = this.options.queue ?? MOCK_NOTIFICATION_QUEUE;
    const controller = new AbortController(); const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    const signal = AbortSignal.any([controller.signal, deadline, ...(externalSignal ? [externalSignal] : [])]);
    let connection: ChannelModel | undefined; let channel: ConfirmChannel | undefined;
    const url = localBrokerUrl(this.options.url);
    const operation = async () => {
      const socketOptions = { timeout: 3000, noDelay: true, signal, clientProperties: { connection_name: 'flowpilot-mock-publisher' } };
      connection = await (this.options.connector ?? connect)({ protocol: 'amqp', hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 5672),
        username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), vhost: url.pathname === '/flowpilot_test' ? 'flowpilot_test' : '/', heartbeat: 5, maxFrameSize: 131072 }, socketOptions);
      connection.on('error', () => { /* Never log credentials or raw protocol errors. */ });
      if (signal.aborted) {
        await connection.close().catch(() => {});
        throw new PublishFailure(externalSignal?.aborted ? 'PUBLISHER_STOPPED' : 'BROKER_TIMEOUT');
      }
      channel = await connection.createConfirmChannel();
      channel.on('error', () => { /* Active publication below rejects safely. */ });
      await channel.assertQueue(queue, { durable: true, exclusive: false, autoDelete: false, arguments: { 'x-queue-type': 'quorum' } });
      if (signal.aborted) throw new PublishFailure(externalSignal?.aborted ? 'PUBLISHER_STOPPED' : 'BROKER_TIMEOUT');
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new PublishFailure('BROKER_UNAVAILABLE'));
        const returned = () => reject(new PublishFailure('UNROUTABLE'));
        channel!.once('close', fail); channel!.once('error', fail); channel!.once('return', returned); connection!.once('close', fail); connection!.once('error', fail);
        // false is stream backpressure, not a broker nack. Exactly one message
        // is outstanding per connection; await its confirm before another send.
        channel!.sendToQueue(queue, Buffer.from(JSON.stringify(event)), { persistent: true, mandatory: true,
          contentType: 'application/json', contentEncoding: 'utf-8', messageId: event.eventId, type: event.eventType,
          timestamp: Math.floor(Date.parse(event.occurredAt) / 1000), appId: 'flowpilot-mock-publisher' }, (error: unknown) => {
          if (error) reject(new PublishFailure('BROKER_NACK')); else resolve();
        });
      });
    };
    let abortListener: (() => void) | undefined;
    try {
      await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new PublishFailure(externalSignal?.aborted ? 'PUBLISHER_STOPPED' : 'BROKER_TIMEOUT'));
        if (signal.aborted) abortListener(); else signal.addEventListener('abort', abortListener, { once: true });
      })]);
    } catch (error) { throw error instanceof PublishFailure ? error : new PublishFailure('BROKER_UNAVAILABLE'); }
    finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
      if (connection) {
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([connection.close().catch(() => {}), new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 500); })]);
        if (closeTimer) clearTimeout(closeTimer);
      }
      controller.abort(); // Close any hung/late socket even if close timed out.
    }
  }
}
