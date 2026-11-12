import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HealthResponseSchema } from '@flowpilot/contracts';
import { buildApp } from './app.js';

test('liveness responds without requiring database or broker connections', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(HealthResponseSchema.parse(response.json()), {
    status: 'ok', service: 'flowpilot-api',
  });
});

test('workflow execution is not exposed in the foundation', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/v1/requests', payload: {} });
  assert.equal(response.statusCode, 404);
});


