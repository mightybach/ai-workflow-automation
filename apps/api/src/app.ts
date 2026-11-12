import Fastify from 'fastify';
import { HealthResponseSchema } from '@flowpilot/contracts';

export function buildApp(options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? false });
  app.get('/api/v1/health/live', async () =>
    HealthResponseSchema.parse({ status: 'ok', service: 'flowpilot-api' }),
  );
  return app;
}


