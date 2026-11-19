import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { businessDayBounds, Prisma, type PrismaClient } from '@flowpilot/db';
import { AddWorkingTimeSchema, CreateClosureSchema, ReleaseClosureSchema, SchedulePolicyQuerySchema, SchedulePolicyResponseSchema,
  SchedulePolicyChangeSchema, ScheduleClosureSchema, IdempotencyHeadersSchema, type AddWorkingTime, type CreateClosure, type ReleaseClosure } from '@flowpilot/contracts';
import { adminActionId, businessAccess, lockOwnedBusiness, requireOwner } from './business-admin.js';
import { ApiError } from './errors.js';
import { scheduleRange } from './schedule-time.js';

type Operation = { kind: 'hours'; body: AddWorkingTime } | { kind: 'close'; body: CreateClosure } | { kind: 'release'; body: ReleaseClosure };
const events = { hours: 'BUSINESS_WORKING_TIME_ADDED', close: 'BUSINESS_CLOSURE_CREATED', release: 'BUSINESS_CLOSURE_RELEASED' } as const;
const replaySchema = z.object({ requestFingerprint: z.string(), response: SchedulePolicyChangeSchema,
  window: z.object({ staffId: z.string().nullable(), startAt: z.string(), endAt: z.string() }) }).strict();
type Closure = Prisma.ScheduleClosureGetPayload<object>;
const closureDto = (row: Closure) => ScheduleClosureSchema.parse({ ...row, startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString(),
  createdAt: row.createdAt.toISOString(), releasedAt: row.releasedAt?.toISOString() ?? null });
function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Use a valid local date, 30-minute time boundaries and the latest revision.');
  return parsed.data;
}
export async function changeSchedulePolicy(db: PrismaClient, request: FastifyRequest, operation: Operation, key: string, clock: () => Date) {
  const initial = await businessAccess(db, request); requireOwner(initial);
  const namespace = `schedule-policy:${operation.kind}:v1`;
  const normalized = operation.kind === 'release' ? [operation.body.closureId.toLowerCase()] :
    [operation.body.staffId?.toLowerCase() ?? null, operation.body.date, operation.body.startMinute, operation.body.endMinute];
  const fingerprint = createHash('sha256').update(JSON.stringify([namespace, normalized, new Date(operation.body.expectedUpdatedAt).toISOString()])).digest('hex');
  const id = adminActionId(namespace, initial.membership.businessId, initial.actor.id, key);
  return db.$transaction(async (tx) => {
    const { actor, membership } = await lockOwnedBusiness(tx, request, initial);
    const prior = await tx.auditEvent.findUnique({ where: { id } });
    if (prior) {
      if (prior.businessId !== membership.businessId || prior.actorId !== actor.id || prior.eventType !== events[operation.kind]) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key is unavailable.');
      const saved = replaySchema.parse(prior.metadata);
      if (saved.requestFingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used for a different schedule operation.');
      return { change: saved.response, replayed: true };
    }
    if (+membership.business.updatedAt !== Date.parse(operation.body.expectedUpdatedAt)) throw new ApiError(409, 'SCHEDULE_CHANGED', 'Settings or schedule changed. Refresh and review again.');
    let now = clock(); let createdCount = 0; let blockedCount = 0; let changed: boolean; let closure: Closure | null = null;
    let window: { staffId: string | null; startAt: Date; endAt: Date };
    if (operation.kind === 'release') {
      const existing = await tx.scheduleClosure.findFirst({ where: { id: operation.body.closureId.toLowerCase(), businessId: membership.businessId } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Closure not found.');
      window = existing;
      closure = existing.releasedAt ? existing : await tx.scheduleClosure.update({ where: { id: existing.id }, data: { releasedAt: now } });
      changed = !existing.releasedAt;
    } else {
      const staffId = operation.body.staffId?.toLowerCase() ?? null;
      window = { staffId, ...scheduleRange(operation.body, membership.business.timezone) };
      if (window.startAt <= now) throw new ApiError(409, 'PAST_SLOT', 'Choose a future working-time or closure interval.');
      if (staffId) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "Staff" WHERE id = ${staffId}::uuid AND "businessId" = ${membership.businessId}::uuid FOR SHARE`);
        const person = await tx.staff.findFirst({ where: { id: staffId, businessId: membership.businessId } });
        if (!person) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
        if (operation.kind === 'hours' && !person.active) throw new ApiError(409, 'STAFF_UNAVAILABLE', 'Working hours require active staff.');
      }
      now = clock();
      if (window.startAt <= now) throw new ApiError(409, 'PAST_SLOT', 'Choose a future working-time or closure interval.');
      const scope = { businessId: membership.businessId, ...(staffId ? { staffId } : {}), startAt: { lt: window.endAt }, endAt: { gt: window.startAt } };
      if (operation.kind === 'hours') {
        const existing = await tx.availabilitySlot.findMany({ where: scope, select: { startAt: true } });
        const starts = new Set(existing.map((slot) => +slot.startAt));
        const rules = await tx.scheduleClosure.findMany({ where: { businessId: membership.businessId, releasedAt: null,
          OR: [{ staffId: null }, { staffId: staffId! }], startAt: { lt: window.endAt }, endAt: { gt: window.startAt } } });
        const data: Prisma.AvailabilitySlotCreateManyInput[] = [];
        for (let time = +window.startAt; time < +window.endAt; time += 1800000) {
          if (starts.has(time)) continue;
          const closed = rules.some((rule) => +rule.startAt < time + 1800000 && +rule.endAt > time);
          if (closed) blockedCount++;
          data.push({ businessId: membership.businessId, staffId: staffId!, startAt: new Date(time), endAt: new Date(time + 1800000), state: closed ? 'BLOCKED' : 'AVAILABLE' });
        }
        if (data.length) createdCount = (await tx.availabilitySlot.createMany({ data })).count;
        changed = createdCount > 0;
      } else {
        if (await tx.scheduleClosure.findFirst({ where: { businessId: membership.businessId, staffId, startAt: window.startAt, endAt: window.endAt, releasedAt: null } })) throw new ApiError(409, 'CLOSURE_EXISTS', 'An active closure already covers this exact scope and interval.');
        const slots = await tx.availabilitySlot.findMany({ where: scope, include: { bookingSlots: { where: { releasedAt: null }, take: 1, select: { bookingId: true } } }, take: 501 });
        if (slots.length > 500) throw new ApiError(409, 'SCHEDULE_TOO_LARGE', 'Use a shorter interval or one staff member.');
        if (slots.some((slot) => slot.state === 'RESERVED' || slot.bookingSlots.length)) throw new ApiError(409, 'SLOT_RESERVED', 'This closure overlaps reserved time. Nothing was changed; choose a different interval.');
        const changedIds = slots.filter((slot) => slot.state === 'AVAILABLE').map((slot) => slot.id);
        if (changedIds.length) {
          const result = await tx.availabilitySlot.updateMany({ where: { businessId: membership.businessId, id: { in: changedIds }, state: 'AVAILABLE', bookingSlots: { none: { releasedAt: null } } }, data: { state: 'BLOCKED' } });
          if (result.count !== changedIds.length) throw new ApiError(409, 'SCHEDULE_CHANGED', 'Inventory changed. Refresh and try again.');
          blockedCount = result.count;
        }
        closure = await tx.scheduleClosure.create({ data: { businessId: membership.businessId, staffId, startAt: window.startAt, endAt: window.endAt, createdAt: now } });
        changed = true;
      }
    }
    const business = changed ? await tx.business.update({ where: { id: membership.businessId }, data: { updatedAt: new Date(Math.max(+now, +membership.business.updatedAt + 1)) } }) : membership.business;
    const change = SchedulePolicyChangeSchema.parse({ businessId: business.id, updatedAt: business.updatedAt.toISOString(), createdCount, blockedCount, closure: closure ? closureDto(closure) : null });
    await tx.auditEvent.create({ data: { id, businessId: business.id, actorId: actor.id, actorType: 'USER',
      entityType: closure ? 'ScheduleClosure' : 'Staff', entityId: closure?.id ?? window.staffId!, eventType: events[operation.kind], traceId: request.id,
      metadata: { requestFingerprint: fingerprint, response: change, window: { staffId: window.staffId, startAt: window.startAt.toISOString(), endAt: window.endAt.toISOString() } }, createdAt: now } });
    return { change, replayed: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 10000 });
}
export function schedulePolicyRoutes(app: FastifyInstance, db: PrismaClient, clock: () => Date) {
  app.get('/api/v1/admin/schedule/policies', async (request) => {
    const query = input(SchedulePolicyQuerySchema, request.query);
    return db.$transaction(async (tx) => {
      const { membership } = await businessAccess(tx, request);
      if (query.staffId && !await tx.staff.findFirst({ where: { id: query.staffId, businessId: membership.businessId } })) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
      const bounds = businessDayBounds(query.date, membership.business.timezone);
      const rows = await tx.scheduleClosure.findMany({ where: { businessId: membership.businessId, releasedAt: null, startAt: { lt: bounds.end }, endAt: { gt: bounds.start },
        ...(query.staffId ? { OR: [{ staffId: null }, { staffId: query.staffId }] } : {}) }, orderBy: [{ startAt: 'asc' }, { id: 'asc' }], take: 501 });
      if (rows.length > 500) throw new ApiError(409, 'SCHEDULE_TOO_LARGE', 'Select a staff member or narrower date.');
      return SchedulePolicyResponseSchema.parse({ businessId: membership.businessId, updatedAt: membership.business.updatedAt.toISOString(), referenceTime: clock().toISOString(), timezone: membership.business.timezone, closures: rows.map(closureDto) });
    }, { isolationLevel: 'RepeatableRead' });
  });
  for (const kind of ['hours', 'close', 'release'] as const) app.put(`/api/v1/admin/schedule/${kind}`, { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    input(z.object({}).strict(), request.query);
    const key = input(IdempotencyHeadersSchema, { 'idempotency-key': request.headers['idempotency-key'] })['idempotency-key'];
    const operation: Operation = kind === 'hours' ? { kind, body: input(AddWorkingTimeSchema, request.body) } : kind === 'close' ? { kind, body: input(CreateClosureSchema, request.body) } : { kind, body: input(ReleaseClosureSchema, request.body) };
    const result = await changeSchedulePolicy(db, request, operation, key, clock); reply.header('Idempotency-Replayed', String(result.replayed)); return result.change;
  });
}
