import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword, type PrismaClient } from '@flowpilot/db';
import { LoginBodySchema, LogoutResponseSchema, SessionResponseSchema, type Role } from '@flowpilot/contracts';
import { ApiError } from './errors.js';
import { userDto, userSelect } from './serialization.js';

const cookieName = 'flowpilot_session';
const lifetimeSeconds = 8 * 60 * 60;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const dummyHash = hashPassword(randomBytes(32).toString('hex'));
export type Actor = { id: string; email: string; role: Role; isActive: boolean; createdAt: Date; updatedAt: Date };

export function authentication(db: PrismaClient) {
  return async (request: FastifyRequest): Promise<Actor> => {
    const token = request.cookies[cookieName];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const session = await db.session.findUnique({
      where: { tokenHash: hashToken(token) }, include: { user: { select: userSelect } },
    });
    if (!session || session.expiresAt <= new Date() || !session.user.isActive) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
    }
    return session.user;
  };
}

export function authRoutes(app: FastifyInstance, db: PrismaClient, demoAuthEnabled: boolean) {
  const authenticate = authentication(db);
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!demoAuthEnabled) throw new ApiError(404, 'NOT_FOUND', 'Demo sign-in is disabled.');
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a valid email and password.');
    const input = parsed.data;
    const user = await db.user.findUnique({ where: { email: input.email } });
    const verified = await verifyPassword(input.password, user?.passwordHash ?? await dummyHash);
    if (!user || !user.isActive || !verified) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const token = randomBytes(32).toString('hex');
    const oldToken = request.cookies[cookieName];
    await db.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { OR: [
        { expiresAt: { lte: new Date() } }, ...(oldToken ? [{ tokenHash: hashToken(oldToken) }] : []),
      ] } });
      await tx.session.create({ data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + lifetimeSeconds * 1000) } });
    });
    reply.setCookie(cookieName, token, { path: '/api', httpOnly: true, sameSite: 'strict', secure: false, maxAge: lifetimeSeconds });
    // Select public fields explicitly; the login query also contained passwordHash.
    return SessionResponseSchema.parse({ user: userDto({
      id: user.id, email: user.email, role: user.role, isActive: user.isActive, createdAt: user.createdAt, updatedAt: user.updatedAt,
    }) });
  });
  app.get('/api/v1/auth/me', async (request) => SessionResponseSchema.parse({ user: userDto(await authenticate(request)) }));
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    reply.clearCookie(cookieName, { path: '/api' });
    return LogoutResponseSchema.parse({ ok: true });
  });
}

