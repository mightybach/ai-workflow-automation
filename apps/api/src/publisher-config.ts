export function localBrokerUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'amqp:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash ||
      !['', '/', '/%2F', '/flowpilot_test'].includes(url.pathname) || !url.username || !url.password) throw new Error('Use a credentialed local AMQP URL and approved vhost.');
  // Validate percent encoding without printing credential values.
  decodeURIComponent(url.username); decodeURIComponent(url.password);
  return url;
}
export function publisherConfig(env: NodeJS.ProcessEnv) {
  if (!env.OUTBOX_PUBLISHER_ENABLED || env.OUTBOX_PUBLISHER_ENABLED === 'false') return { enabled: false as const };
  if (env.OUTBOX_PUBLISHER_ENABLED !== 'true') throw new Error('Invalid publisher opt-in.');
  const database = new URL(env.DATABASE_URL ?? '');
  if (!['postgresql:', 'postgres:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) || !['/flowpilot', '/flowpilot_test'].includes(database.pathname)) throw new Error('Use a dedicated local demo/test database.');
  const broker = localBrokerUrl(env.RABBITMQ_URL ?? '');
  // Keep synthetic integration messages out of the application's vhost.
  if ((database.pathname === '/flowpilot_test') !== (broker.pathname === '/flowpilot_test')) throw new Error('Test database and broker vhost must be paired.');
  return { enabled: true as const, databaseUrl: database.href, brokerUrl: broker.href };
}
export function workerQueue(env: NodeJS.ProcessEnv, brokerUrl: string) {
  const value = env.TEST_NOTIFICATION_QUEUE;
  if (!value) return 'flowpilot.mock.notifications.v1';
  if (localBrokerUrl(brokerUrl).pathname !== '/flowpilot_test' || !/^flowpilot\.mock\.notifications\.v1\.test-[a-f0-9-]+$/.test(value)) throw new Error('Custom queues require the isolated test vhost.');
  return value;
}
