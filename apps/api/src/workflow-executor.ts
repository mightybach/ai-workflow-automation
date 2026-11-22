import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@flowpilot/db';
type Run = Prisma.BusinessWorkflowRunGetPayload<object>;
type Options = { clock?: () => Date; businessId?: string; limit?: number };
async function time(tx: Prisma.TransactionClient, clock?: () => Date) {
  return clock ? clock() : (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]!.now;
}
export async function claimWorkflowRun(db: PrismaClient, options: Options = {}): Promise<{ kind: 'dead' } | { kind: 'claimed'; run: Run } | null> {
  return db.$transaction(async (tx) => {
    const now = await time(tx, options.clock); const scope = options.businessId ? Prisma.sql`AND "businessId" = ${options.businessId}::uuid` : Prisma.empty;
    const [row] = await tx.$queryRaw<Run[]>(Prisma.sql`SELECT * FROM "BusinessWorkflowRun" WHERE status = 'PENDING' AND "availableAt" <= ${now}
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now}) ${scope} ORDER BY "availableAt", id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!row) return null;
    if (row.attempts >= 5) {
      await tx.businessWorkflowRun.update({ where: { id: row.id }, data: { status: 'DEAD', finishedAt: now, lastErrorCode: 'ATTEMPTS_EXHAUSTED', leaseToken: null, leaseExpiresAt: null } });
      return { kind: 'dead' as const };
    }
    const saved = await tx.businessWorkflowRun.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, leaseToken: randomUUID(), leaseExpiresAt: new Date(+now + 30000) } });
    return { kind: 'claimed' as const, run: saved };
  });
}
export async function executeWorkflowRun(db: PrismaClient, claim: Run, clock?: () => Date) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${claim.businessId}::uuid FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "BusinessWorkflowRun" WHERE id = ${claim.id}::uuid AND "businessId" = ${claim.businessId}::uuid FOR UPDATE`);
    const run = await tx.businessWorkflowRun.findUniqueOrThrow({ where: { id: claim.id }, include: { definition: true, business: true, booking: { include: { proposal: true } } } });
    const now = await time(tx, clock);
    if (run.status !== 'PENDING' || run.leaseToken !== claim.leaseToken || !run.leaseExpiresAt || run.leaseExpiresAt <= now) return 'lost' as const;
    const reason = !run.business.active ? 'BUSINESS_INACTIVE' : !run.definition.enabled ? 'WORKFLOW_DISABLED' : run.activationId !== run.definition.activationId ? 'ACTIVATION_CHANGED' : run.booking.status !== 'CONFIRMED' ? 'BOOKING_CHANGED' : run.booking.proposal.startAt <= now ? 'APPOINTMENT_STARTED' : null;
    if (reason) {
      await tx.businessWorkflowRun.update({ where: { id: run.id }, data: { status: 'SUPPRESSED', resultCode: reason, finishedAt: now, lastErrorCode: null, leaseToken: null, leaseExpiresAt: null } });
      return 'suppressed' as const;
    }
    const task = await tx.businessTask.create({ data: { businessId: run.businessId, definitionId: run.definitionId, runId: run.id, bookingId: run.bookingId,
      kind: run.definition.template, dueAt: run.booking.proposal.startAt, createdAt: now, updatedAt: now } });
    await tx.businessWorkflowRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', resultCode: 'TASK_CREATED', lastErrorCode: null, finishedAt: now, leaseToken: null, leaseExpiresAt: null } });
    await tx.auditEvent.create({ data: { businessId: run.businessId, entityType: 'BusinessTask', entityId: task.id, actorType: 'WORKER', actorId: null,
      eventType: 'WORKFLOW_TASK_CREATED', traceId: randomUUID(), metadata: { template: run.definition.template }, createdAt: now } });
    return 'created' as const;
  }, { timeout: 5000 });
}
async function failRun(db: PrismaClient, claim: Run, clock?: () => Date) {
  return db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Run[]>(Prisma.sql`SELECT * FROM "BusinessWorkflowRun" WHERE id = ${claim.id}::uuid AND "businessId" = ${claim.businessId}::uuid FOR UPDATE`);
    const now = await time(tx, clock);
    if (!row || row.status !== 'PENDING' || row.leaseToken !== claim.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= now) return 'lost' as const;
    await tx.businessWorkflowRun.update({ where: { id: row.id }, data: { status: row.attempts === 5 ? 'DEAD' : 'PENDING', lastErrorCode: 'PROCESSING_FAILED',
      finishedAt: row.attempts === 5 ? now : null, availableAt: new Date(+now + 5000 * 2 ** (row.attempts - 1)), leaseToken: null, leaseExpiresAt: null } });
    return row.attempts === 5 ? 'dead' as const : 'retried' as const;
  });
}
export async function workflowBatch(db: PrismaClient, options: Options = {}) {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Workflow limit must be 1..100.');
  const result = { created: 0, suppressed: 0, dead: 0, lost: 0, retried: 0, expired: 0 };
  for (let n = 0; n < limit; n++) {
    const next = await claimWorkflowRun(db, options); if (!next) break;
    if (next.kind === 'dead') { result.dead++; continue; }
    try { result[await executeWorkflowRun(db, next.run, options.clock)]++; }
    catch { result[await failRun(db, next.run, options.clock)]++; }
  }
  const scanTime = options.clock ? options.clock() : (await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]!.now;
  const expired = await db.businessTask.findMany({ where: { status: 'OPEN', dueAt: { lte: scanTime }, ...(options.businessId ? { businessId: options.businessId } : {}) }, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: limit });
  for (const candidate of expired) result.expired += await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${candidate.businessId}::uuid FOR UPDATE`);
    const now = await time(tx, options.clock);
    const changed = await tx.businessTask.updateMany({ where: { id: candidate.id, businessId: candidate.businessId, status: 'OPEN', dueAt: { lte: now } }, data: { status: 'EXPIRED', closedAt: now, revision: { increment: 1 }, updatedAt: now } });
    if (changed.count) await tx.auditEvent.create({ data: { businessId: candidate.businessId, entityType: 'BusinessTask', entityId: candidate.id, actorType: 'WORKER', actorId: null, eventType: 'WORKFLOW_TASK_EXPIRED', traceId: randomUUID(), createdAt: now } });
    return changed.count;
  });
  return result;
}
