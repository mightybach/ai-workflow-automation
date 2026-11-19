import { ApiErrorSchema } from '@flowpilot/contracts';

export class ApiFailure extends Error {
  constructor(public readonly status: number, message: string, public readonly traceId?: string, public readonly code?: string) { super(message); }
}
export async function apiRequest<T>(path: string, schema: {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}, options: {
  method?: 'GET' | 'POST' | 'PUT'; body?: unknown; idempotencyKey?: string; signal?: AbortSignal; timeoutMs?: number;
} = {}): Promise<T> {
  let response: Response;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
  try {
    response = await fetch('/api/v1' + path, {
      method: options.method ?? 'GET', credentials: 'same-origin',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.method && options.method !== 'GET' ? { 'X-Flowpilot-Client': 'web' } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiFailure(0, 'Could not reach the API. Check your connection and try again.');
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event(path.startsWith('/customer/') ? 'flowpilot-customer-session-expired' : 'flowpilot-session-expired'));
    throw new ApiFailure(response.status, parsed.success ? parsed.data.message : 'The request failed.', parsed.success ? parsed.data.traceId : undefined, parsed.success ? parsed.data.code : undefined);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiFailure(502, 'The API returned an unexpected response.');
  return parsed.data;
}
export function errorMessage(error: unknown) {
  if (error instanceof ApiFailure) return error.message + (error.traceId ? ' Reference: ' + error.traceId : '');
  return 'Something went wrong. Please try again.';
}

