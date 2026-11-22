import { setTimeout as delay } from 'node:timers/promises';
import { createDatabaseClient } from '@flowpilot/db';
import { workflowBatch } from './workflow-executor.js';
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
try {
  if (process.argv.slice(2).some((arg) => arg !== '--once')) throw new Error('Invalid worker option.');
  if (process.env.WORKFLOW_WORKER_ENABLED === undefined || process.env.WORKFLOW_WORKER_ENABLED === 'false') console.log(JSON.stringify({ service: 'workflow-worker', status: 'disabled' }));
  else {
    if (process.env.WORKFLOW_WORKER_ENABLED !== 'true') throw new Error('Invalid opt-in.');
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['/flowpilot', '/flowpilot_test'].includes(url.pathname)) throw new Error('Use a local demo/test database.');
    const db = createDatabaseClient(url.href);
    try { do {
      try { console.log(JSON.stringify({ service: 'workflow-worker', ...await workflowBatch(db) })); }
      catch { console.error(JSON.stringify({ service: 'workflow-worker', error: 'WORKFLOW_UNAVAILABLE' })); if (process.argv.includes('--once')) process.exitCode = 1; }
      if (process.argv.includes('--once') || stop.signal.aborted) break;
      try { await delay(1000, undefined, { signal: stop.signal }); } catch { break; }
    } while (!stop.signal.aborted); } finally { await db.$disconnect(); }
  }
} catch { console.error(JSON.stringify({ service: 'workflow-worker', error: 'WORKFLOW_FAILED' })); process.exitCode = 1; }
