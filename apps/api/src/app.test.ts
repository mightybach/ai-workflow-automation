import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HealthResponseSchema } from '@flowpilot/contracts';
import { buildApp } from './app.js';
import type { PrismaClient } from '@flowpilot/db';

test('liveness responds without requiring database or broker connections', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(HealthResponseSchema.parse(response.json()), {
    status: 'ok', service: 'flowpilot-api',
  });
});

test('business routes remain unavailable without database configuration', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/v1/requests', payload: {} });
  assert.equal(response.statusCode, 404);
});

test('readiness fails safely when PostgreSQL is unavailable', async (t) => {
  const db = { $queryRaw: async () => { throw new Error('private database credentials'); } } as unknown as PrismaClient;
  const app = buildApp({ db });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'NOT_READY');
  assert.equal(response.body.includes('credentials'), false);
});

test('unexpected errors expose a trace reference without leaking private details', async (t) => {
  const app = buildApp();
  app.get('/test/failure', () => { throw new Error('secret text must not escape'); });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/test/failure', headers: { 'x-request-id': 'attacker-supplied' } });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, 'INTERNAL_ERROR');
  assert.notEqual(response.json().traceId, 'attacker-supplied');
  assert.equal(response.body.includes('secret'), false);
});


