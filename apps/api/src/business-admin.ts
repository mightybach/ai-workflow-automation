import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@flowpilot/db';
import { authentication, type Actor } from './auth.js';
import { ApiError } from './errors.js';

export type BusinessAccess = { actor: Actor; membership: Prisma.BusinessMembershipGetPayload<{ include: { business: true } }> };
export async function businessAccess(db: Pick<PrismaClient, 'session' | 'businessMembership'>, request: FastifyRequest): Promise<BusinessAccess> {
  const actor = await authentication(db)(request);
  const membership = await db.businessMembership.findUnique({ where: { userId: actor.id }, include: { business: true } });
  if (!membership?.active || !membership.business.active) throw new ApiError(403, 'BUSINESS_ACCESS_REQUIRED', 'This account has no active business access.');
  return { actor, membership };
}
export function requireOwner(access: BusinessAccess) {
  if (access.membership.role !== 'OWNER') throw new ApiError(403, 'OWNER_REQUIRED', 'Only a business owner can change business settings or availability.');
}
export async function lockOwnedBusiness(tx: Prisma.TransactionClient, request: FastifyRequest, initial: BusinessAccess): Promise<BusinessAccess> {
  const tokenHash = createHash('sha256').update(request.cookies.flowpilot_session!).digest('hex');
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Business" WHERE id = ${initial.membership.businessId}::uuid FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "tokenHash" FROM "Session" WHERE "tokenHash" = ${tokenHash} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "User" WHERE id = ${initial.actor.id}::uuid FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "BusinessMembership" WHERE id = ${initial.membership.id}::uuid FOR SHARE`);
  const current = await businessAccess(tx, request);
  requireOwner(current);
  if (current.membership.businessId !== initial.membership.businessId) throw new ApiError(403, 'OWNER_REQUIRED', 'Active ownership of this business is required.');
  return current;
}
// Preserve the existing settings namespace and byte layout: previously saved
// audit actions must retain their exact IDs/replay semantics after this refactor.
export function adminActionId(namespace: string, businessId: string, actorId: string, key: string) {
  const bytes = createHash('sha256').update(JSON.stringify([namespace, businessId, actorId, key])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
