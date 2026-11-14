import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '../dist/index.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
const target = new URL(process.env.TEST_DATABASE_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/flowpilot_test') {
  throw new Error('Tests require the dedicated local flowpilot_test database.');
}
const adminUrl = new URL(target);
adminUrl.pathname = '/postgres';
const admin = createDatabaseClient(adminUrl.href);
try {
  const existing = await admin.$queryRaw`SELECT datname FROM pg_database WHERE datname = 'flowpilot_test'`;
  if (existing.length === 0) {
    // Fixed trusted DDL. Never interpolate external names into CREATE DATABASE.
    await admin.$executeRawUnsafe('CREATE DATABASE "flowpilot_test"');
  }
} finally { await admin.$disconnect(); }
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)),
  'migrate', 'deploy', '--config', 'prisma7.config.ts',
], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, DATABASE_URL: target.href }, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;

