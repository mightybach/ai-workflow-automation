import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@flowpilot/db';
import { CUSTOMER_SESSION_TTL_SECONDS, CustomerSessionResponseSchema } from '@flowpilot/contracts';
import { businessDate } from '@flowpilot/db';
import { ApiError } from './errors.js';

export const customerCookieName = 'flowpilot_customer_session';
export const customerCookieOptions = {
  path: '/api/v1/customer', httpOnly: true, sameSite: 'strict' as const, secure: false,
};
export const customerTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function requestCustomerToken(request: FastifyRequest) {
  const token = request.cookies[customerCookieName];
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
export async function customerScope(tx: Prisma.TransactionClient, request: FastifyRequest, now: Date) {
  const token = requestCustomerToken(request);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Start a customer session to continue.');
  const session = await tx.customerSession.findUnique({
    where: { tokenHash: customerTokenHash(token) }, include: { business: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= now || !session.business.active) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Your customer session is unavailable. Start a new session.');
  }
  return session;
}
export function customerSessionDto(session: Awaited<ReturnType<typeof customerScope>>, now: Date) {
  return CustomerSessionResponseSchema.parse({
    businessId: session.businessId, businessName: session.business.name,
    timezone: session.business.timezone, today: businessDate(now, session.business.timezone),
    maxBookingDurationMinutes: session.business.maxBookingDurationMinutes, expiresAt: session.expiresAt.toISOString(),
  });
}
export function newCustomerToken(now: Date) {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: customerTokenHash(token), expiresAt: new Date(+now + CUSTOMER_SESSION_TTL_SECONDS * 1000) };
}
