import { z } from 'zod';
import { createDatabaseClient } from '@flowpilot/db';
import { buildApp } from './app.js';
import { configuredExtractor } from './ai-config.js';

const result = z.object({
  API_HOST: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test']).default('development'),
  DEMO_AUTH_ENABLED: z.literal('true'),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
}).safeParse(process.env);
if (!result.success) {
  // Do not print input values: the environment may contain credentials.
  throw new Error('Invalid configuration: ' + result.error.issues.map((issue) => issue.path.join('.')).join(', '));
}
const env = result.data;
const origin = new URL(env.WEB_ORIGIN);
if (origin.origin !== env.WEB_ORIGIN || origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw new Error('Demo mode requires an exact localhost HTTP WEB_ORIGIN.');
}
const intentExtractor = configuredExtractor(process.env);
const db = createDatabaseClient(env.DATABASE_URL);
const app = buildApp({ logger: true, db, demoAuthEnabled: true, webOrigin: env.WEB_ORIGIN, intentExtractor });
app.addHook('onClose', async () => { await db.$disconnect(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
}
try { await app.listen({ host: env.API_HOST, port: env.API_PORT }); }
catch { app.log.error('API failed to start'); await app.close(); process.exitCode = 1; }

