import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createDatabaseClient, hashPassword } from '@flowpilot/db';
import { buildApp } from './app.js';
import { createRequest } from './request-service.js';

const origin = 'http://127.0.0.1:5173';
const writeHeaders = { origin, 'x-flowpilot-client': 'web' };
const password = 'synthetic-test-password';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required; use pnpm test:integration.');
const target = new URL(databaseUrl);
if (target.pathname !== '/flowpilot_test' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
  throw new Error('Integration tests require the isolated local flowpilot_test database.');
}

test('Phase 1 persistence and authorization', async (t) => {
  const db = createDatabaseClient(databaseUrl);
  const tag = randomUUID();
  const passwordHash = await hashPassword(password);
  const users = await Promise.all(['CLIENT', 'CLIENT', 'ADMIN', 'REVIEWER'].map((role, index) =>
    db.user.create({ data: { email: 'test-' + tag + '-' + index + '@flowpilot.test', role: role as 'CLIENT' | 'ADMIN' | 'REVIEWER', passwordHash } })));
  const ids = users.map((user) => user.id);
  const app = buildApp({ db, demoAuthEnabled: true, webOrigin: origin });
  t.after(async () => {
    await app.close();
    await db.auditEvent.deleteMany({ where: { run: { request: { createdById: { in: ids } } } } });
    await db.workflow.deleteMany({ where: { request: { createdById: { in: ids } } } });
    await db.request.deleteMany({ where: { createdById: { in: ids } } });
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });
  async function login(index: number) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: writeHeaders, payload: { email: users[index]!.email, password } });
    assert.equal(response.statusCode, 200);
    assert.equal('passwordHash' in response.json().user, false);
    const header = String(response.headers['set-cookie']);
    assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/);
    return header.split(';')[0]!;
  }
  let a = '';
  let b = '';
  let admin = '';
  let reviewer = '';
  let requestId = '';
  let workflowId = '';

  await t.test('unauthenticated and cross-origin requests are rejected with traceable errors', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/requests' });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.json().code, 'UNAUTHENTICATED');
    assert.equal(typeof unauthorized.json().traceId, 'string');
    assert.equal(unauthorized.headers['x-trace-id'], unauthorized.json().traceId);
    for (const headers of [{}, { origin: 'https://evil.test', 'x-flowpilot-client': 'web' }, { origin }]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: users[0]!.email, password } });
      assert.equal(response.statusCode, 403);
    }
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: writeHeaders, payload: { email: users[0]!.email, password: 'wrong' } });
    assert.equal(wrong.statusCode, 401);
    const forgedRole = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: writeHeaders, payload: { email: users[0]!.email, password, role: 'ADMIN' } });
    assert.equal(forgedRole.statusCode, 400);
    a = await login(0); b = await login(1); admin = await login(2); reviewer = await login(3);
    const hash = createHash('sha256').update(a.split('=')[1]!).digest('hex');
    assert.ok(await db.session.findUnique({ where: { tokenHash: hash } }));
  });

  await t.test('invalid bodies and missing keys cannot create records or set authority fields', async () => {
    for (const payload of [{ rawText: ' ' }, { rawText: 'x'.repeat(10001) }, { rawText: 'Synthetic', createdById: users[2]!.id }, { rawText: 'Synthetic', status: 'COMPLETED' }, { rawText: 'Synthetic', approved: true }]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/requests', headers: { ...writeHeaders, cookie: a, 'idempotency-key': 'invalid' }, payload });
      assert.equal(response.statusCode, 400);
    }
    const missing = await app.inject({ method: 'POST', url: '/api/v1/requests', headers: { ...writeHeaders, cookie: a }, payload: { rawText: 'Synthetic' } });
    assert.equal(missing.statusCode, 400);
    assert.equal(await db.request.count({ where: { createdById: users[0]!.id } }), 0);
    const forgedIdentity = await app.inject({ method: 'GET', url: '/api/v1/requests', headers: { 'x-user-id': users[2]!.id, 'x-role': 'ADMIN' } });
    assert.equal(forgedIdentity.statusCode, 401);
  });

  await t.test('concurrent duplicate submissions create one request, run and audit event', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({
      method: 'POST', url: '/api/v1/requests',
      headers: { ...writeHeaders, cookie: a, 'idempotency-key': 'same-key' }, payload: { rawText: 'Synthetic refund ' + tag },
    })));
    for (const response of responses) assert.equal(response.statusCode, 202);
    assert.equal(new Set(responses.map((response) => response.json().requestId)).size, 1);
    requestId = responses[0]!.json().requestId; workflowId = responses[0]!.json().workflowRunId;
    assert.equal(await db.request.count({ where: { id: requestId } }), 1);
    assert.equal(await db.workflow.count({ where: { requestId } }), 1);
    assert.equal(await db.auditEvent.count({ where: { runId: workflowId, eventType: 'REQUEST_CREATED' } }), 1);
    const run = await db.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    assert.equal(run.status, 'PENDING'); assert.equal(run.category, null); assert.equal(run.version, 0);
    const conflict = await app.inject({ method: 'POST', url: '/api/v1/requests', headers: { ...writeHeaders, cookie: a, 'idempotency-key': 'same-key' }, payload: { rawText: 'Different content' } });
    assert.equal(conflict.statusCode, 409);
    const race = await Promise.all(['First content', 'Second content'].map((rawText) => app.inject({
      method: 'POST', url: '/api/v1/requests', headers: { ...writeHeaders, cookie: a, 'idempotency-key': 'conflicting-race' }, payload: { rawText },
    })));
    assert.deepEqual(race.map((response) => response.statusCode).sort(), [202, 409]);
    assert.equal(await db.request.count({ where: { createdById: users[0]!.id, idempotencyKey: 'conflicting-race' } }), 1);
  });

  await t.test('CLIENT ownership applies to lists, counts, request details and workflow details', async () => {
    const other = await app.inject({ method: 'POST', url: '/api/v1/requests', headers: { ...writeHeaders, cookie: b, 'idempotency-key': 'same-key' }, payload: { rawText: 'Other client ' + tag } });
    assert.equal(other.statusCode, 202); assert.notEqual(other.json().requestId, requestId);
    const list = await app.inject({ method: 'GET', url: '/api/v1/requests', headers: { cookie: b } });
    assert.equal(list.json().pagination.total, 1);
    assert.equal(list.json().items[0].createdById, users[1]!.id);
    assert.equal('rawText' in list.json().items[0], false);
    for (const route of ['/requests/' + requestId, '/workflows/' + workflowId]) {
      const denied = await app.inject({ method: 'GET', url: '/api/v1' + route, headers: { cookie: b } });
      assert.equal(denied.statusCode, 404);
      for (const cookie of [a, admin, reviewer]) {
        const allowed = await app.inject({ method: 'GET', url: '/api/v1' + route, headers: { cookie } });
        assert.equal(allowed.statusCode, 200);
        assert.equal('idempotencyKey' in allowed.json(), false);
      }
    }
    const bypass = await app.inject({ method: 'GET', url: '/api/v1/requests?createdById=' + users[2]!.id, headers: { cookie: b } });
    assert.equal(bypass.statusCode, 400);
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      assert.equal((await app.inject({ method, url: '/api/v1/requests/' + requestId, headers: { ...writeHeaders, cookie: admin } })).statusCode, 404);
    }
  });

  await t.test('filters, pagination and run matching obey contracts', async () => {
    const filtered = await app.inject({ method: 'GET', url: '/api/v1/requests?search=' + tag + '&status=PENDING&pageSize=1', headers: { cookie: admin } });
    assert.equal(filtered.statusCode, 200); assert.equal(filtered.json().items.length, 1);
    assert.equal(filtered.json().pagination.total, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/requests?pageSize=51', headers: { cookie: a } })).statusCode, 400);
    await db.workflow.update({ where: { id: workflowId }, data: { category: 'TECHNICAL_SUPPORT' } });
    await db.workflow.create({ data: { requestId, status: 'COMPLETED', category: 'REFUND_REQUEST', completedAt: new Date() } });
    const mixed = await app.inject({ method: 'GET', url: '/api/v1/requests?status=PENDING&category=REFUND_REQUEST', headers: { cookie: a } });
    assert.equal(mixed.json().pagination.total, 0);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/requests/' + randomUUID(), headers: { cookie: admin } });
    assert.equal(missing.statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/requests/not-a-uuid', headers: { cookie: a } })).statusCode, 400);
  });

  await t.test('failure writing audit history rolls back request and workflow creation', async () => {
    const actor = users[0]!;
    await assert.rejects(createRequest(db, actor, { rawText: 'Should roll back' }, 'rollback-key', undefined as unknown as string));
    assert.equal(await db.request.count({ where: { createdById: actor.id, idempotencyKey: 'rollback-key' } }), 0);
  });

  await t.test('an actual API restart preserves requests and sessions', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('Could not select test port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    let child: ChildProcess | undefined;
    async function stop() {
      const running = child;
      child = undefined;
      if (running && running.exitCode === null && running.signalCode === null) {
        const exited = once(running, 'exit'); running.kill(); await exited;
      }
    }
    async function start() {
      child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        cwd: process.cwd(), windowsHide: true, stdio: 'ignore',
        env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(port), API_HOST: '127.0.0.1', NODE_ENV: 'test', DEMO_AUTH_ENABLED: 'true', WEB_ORIGIN: origin },
      });
      for (let attempt = 0; attempt < 80; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Restart test server exited');
        try { if ((await fetch('http://127.0.0.1:' + port + '/api/v1/health/ready', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Starting. */ }
        await delay(100);
      }
      throw new Error('Restart test server did not become ready');
    }
    try {
      await start();
      const base = 'http://127.0.0.1:' + port + '/api/v1';
      const saved = await fetch(base + '/requests', { method: 'POST', headers: { ...writeHeaders, cookie: a, 'Content-Type': 'application/json', 'Idempotency-Key': 'restart-key' }, body: JSON.stringify({ rawText: 'Survives process restart' }) });
      assert.equal(saved.status, 202);
      const created = await saved.json() as { requestId: string };
      await stop(); await start();
      const restored = await fetch(base + '/requests/' + created.requestId, { headers: { cookie: a } });
      assert.equal(restored.status, 200);
      assert.equal((await restored.json() as { rawText: string }).rawText, 'Survives process restart');
    } finally { await stop(); }
  });

  await t.test('disabled users, expired sessions, rotation and logout prevent session reuse', async () => {
    await db.user.update({ where: { id: users[1]!.id }, data: { isActive: false } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: b } })).statusCode, 401);
    await db.user.update({ where: { id: users[1]!.id }, data: { isActive: true } });
    const old = a;
    const rotated = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...writeHeaders, cookie: old }, payload: { email: users[0]!.email, password } });
    assert.equal(rotated.statusCode, 200); a = String(rotated.headers['set-cookie']).split(';')[0]!;
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: old } })).statusCode, 401);
    const adminHash = createHash('sha256').update(admin.split('=')[1]!).digest('hex');
    await db.session.update({ where: { tokenHash: adminHash }, data: { expiresAt: new Date(0) } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: admin } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...writeHeaders, cookie: a } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: a } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: 'flowpilot_session=' + 'a'.repeat(64) } })).statusCode, 401);
  });

  await t.test('login attempts are rate limited', async () => {
    const limited = buildApp({ db, demoAuthEnabled: true, webOrigin: origin });
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        assert.equal((await limited.inject({ method: 'POST', url: '/api/v1/auth/login', headers: writeHeaders, payload: {} })).statusCode, 400);
      }
      const response = await limited.inject({ method: 'POST', url: '/api/v1/auth/login', headers: writeHeaders, payload: {} });
      assert.equal(response.statusCode, 429);
      assert.equal(response.json().code, 'RATE_LIMITED');
    } finally { await limited.close(); }
  });

  await t.test('demo seeds can be repeated without resetting existing users or orders', async () => {
    const directory = fileURLToPath(new URL('../../../packages/db/', import.meta.url));
    async function seed(demoPassword: string) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/seed.ts'], {
        cwd: directory, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test', DEMO_AUTH_ENABLED: 'true', DEMO_PASSWORD: demoPassword },
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
    }
    await seed(password);
    const before = await db.user.findUniqueOrThrow({ where: { email: 'client@flowpilot.test' } });
    const order = await db.mockOrder.findUniqueOrThrow({ where: { orderNumber: '12345' } });
    await seed('different-demo-password');
    const after = await db.user.findUniqueOrThrow({ where: { email: 'client@flowpilot.test' } });
    assert.equal(after.id, before.id); assert.equal(after.passwordHash, before.passwordHash);
    assert.equal((await db.mockOrder.findUniqueOrThrow({ where: { orderNumber: '12345' } })).id, order.id);
    assert.equal(await db.user.count({ where: { email: { in: ['client@flowpilot.test', 'reviewer@flowpilot.test', 'admin@flowpilot.test'] } } }), 3);
  });
});

