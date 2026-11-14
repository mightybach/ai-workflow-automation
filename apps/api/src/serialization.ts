import { UserResponseSchema, WorkflowResponseSchema } from '@flowpilot/contracts';

export const userSelect = { id: true, email: true, role: true, isActive: true, createdAt: true, updatedAt: true } as const;
export function userDto(user: { id: string; email: string; role: string; isActive: boolean; createdAt: Date; updatedAt: Date }) {
  return UserResponseSchema.parse({ ...user, createdAt: user.createdAt.toISOString(), updatedAt: user.updatedAt.toISOString() });
}
export function workflowDto(run: { id: string; requestId: string; category: string | null; status: string; version: number; createdAt: Date; updatedAt: Date; completedAt: Date | null }) {
  return WorkflowResponseSchema.parse({
    id: run.id, requestId: run.requestId, category: run.category, status: run.status, version: run.version,
    createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null,
  });
}

