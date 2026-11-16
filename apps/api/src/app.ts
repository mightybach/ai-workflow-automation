import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@flowpilot/db';
import { HealthResponseSchema, ApiErrorSchema } from '@flowpilot/contracts';
import { ApiError } from './errors.js';
import { authRoutes } from './auth.js';
import { requestRoutes } from './request-routes.js';
import { businessRoutes } from './business-routes.js';

export function buildApp(options: { logger?: boolean; db?: PrismaClient; demoAuthEnabled?: boolean; webOrigin?: string; clock?: () => Date } = {}) {
  const app = Fastify({
    bodyLimit: 64 * 1024, requestIdHeader: false, genReqId: () => randomUUID(),
    logger: options.logger ? {
      redact: ['req.headers.cookie', 'req.headers.authorization'],
      serializers: { req: (request) => ({ method: request.method, url: request.url.split('?')[0] ?? '/' }) },
    } : false,
  });
  app.setErrorHandler((error, request, reply) => {
    const expected = error instanceof ApiError;
    const frameworkStatus = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const statusCode = expected ? error.statusCode : frameworkStatus >= 400 && frameworkStatus < 500 ? frameworkStatus : 500;
    const code = expected ? error.code : statusCode === 429 ? 'RATE_LIMITED' : statusCode < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
    const message = expected ? error.message : statusCode === 429 ? 'Too many requests. Try again later.' : statusCode < 500 ? 'Invalid request.' : 'The request could not be completed.';
    if (statusCode >= 500) app.log.error({ traceId: request.id }, 'Request failed');
    reply.code(statusCode).send(ApiErrorSchema.parse({ code, message, traceId: request.id }));
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(ApiErrorSchema.parse({ code: 'NOT_FOUND', message: 'Endpoint not found.', traceId: request.id }));
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Trace-Id', request.id).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
  });
  app.get('/api/v1/health/live', async () => HealthResponseSchema.parse({ status: 'ok', service: 'flowpilot-api' }));
  if (options.db) {
    const db = options.db;
    app.register(async (api) => {
      await api.register(cookie);
      await api.register(rateLimit, { max: 300, timeWindow: '1 minute' });
      // Browser CSRF defence: unsafe requests require the configured exact Origin
      // and a custom header (cross-origin pages cannot supply it without CORS).
      // No CORS permission is exposed. API clients must send these headers too.
      api.addHook('onRequest', async (request) => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
          if (request.headers.origin !== (options.webOrigin ?? 'http://127.0.0.1:5173') || request.headers['x-flowpilot-client'] !== 'web') {
            throw new ApiError(403, 'FORBIDDEN', 'Request origin is not permitted.');
          }
        }
      });
      api.get('/api/v1/health/ready', async () => {
        try { await db.$queryRaw`SELECT 1`; }
        catch { throw new ApiError(503, 'NOT_READY', 'Database is unavailable.'); }
        return { status: 'ok' };
      });
      authRoutes(api, db, options.demoAuthEnabled ?? false);
      requestRoutes(api, db);
      businessRoutes(api, db, options.clock ?? (() => new Date()));
    });
  }
  return app;
}

