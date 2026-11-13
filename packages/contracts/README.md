# Phase 1 API contracts

These are shared Zod schemas and inferred TypeScript types. They define the planned HTTP boundary; only the liveness endpoint is currently implemented. They do not grant authorization, persist records, execute workflows or replace database constraints.

Import through `@flowpilot/contracts`. The package remains browser-safe and does not import Prisma or database credentials.

## Planned endpoints

Base path: `/api/v1`.

| Method | Path | Input | Success response |
| --- | --- | --- | --- |
| GET | /health/live | None | 200 HealthResponseSchema |
| POST | /requests | CreateRequestBodySchema + IdempotencyHeadersSchema | 202 CreateRequestResponseSchema |
| GET | /requests | RequestListQuerySchema | 200 RequestListResponseSchema |
| GET | /requests/:id | IdParamsSchema | 200 RequestDetailSchema |
| GET | /workflows/:id | IdParamsSchema | 200 WorkflowResponseSchema |

All request/workflow routes require authenticated access when implemented. The server must derive the creator from that identity and enforce read/write permissions. The owner's CLIENT role exists in the schema, but its exact resource permissions must be agreed before route implementation. No unauthenticated business route should be exposed while that decision is pending.

UserResponseSchema, AuditEventResponseSchema and MockOrderResponseSchema are safe-shape DTOs for later authorized reads; this change does not add user/admin/audit/order endpoints. Authentication, approvals, execution, cancellation and retry contracts are deferred to their implementation slices.

## Create a request

```http
POST /api/v1/requests
Content-Type: application/json
Idempotency-Key: demo-request-001

{"rawText":"My synthetic order 12345 arrived damaged."}
```

The body accepts only rawText: 1–10,000 characters with at least one non-whitespace character. Preserve original text exactly. Identity, role, timestamps, status, category and approvals cannot be supplied in the body. No source or payloadHash field is invented for the migrated schema.

The required key is 1–128 characters from letters, digits, period, underscore, colon or hyphen. It is scoped by the authenticated creator, matching the database's composite unique constraint. Same creator/key and identical rawText must return the original request and initial run identifiers without creating another run/audit event. A different rawText with that key must return 409 IDEMPOTENCY_CONFLICT. This must be implemented transactionally; parsing alone does not provide idempotency. A replay may report the existing run's current status, while a new run starts PENDING.

Example response:

```json
{
  "requestId": "c27a63c1-2459-47bb-8d5c-f3fc15bd1ddd",
  "workflowRunId": "8c21b672-d7ac-4dd1-805d-bd37bad90483",
  "status": "PENDING"
}
```

Fastify normalizes header names to lowercase. Parse the selected header, not the entire framework headers object, because the schema is strict:

```ts
const body = CreateRequestBodySchema.parse(request.body);
const headers = IdempotencyHeadersSchema.parse({
  'idempotency-key': request.headers['idempotency-key'],
});
```

## List and detail

List query fields:

| Field | Rule |
| --- | --- |
| page | Positive integer or digit string; default 1, maximum 100000 |
| pageSize | Positive integer or digit string; default 10, maximum 50 |
| search | Optional trimmed nonblank text, maximum 200 characters |
| status | Optional WorkflowStatus enum |
| category | Optional WorkflowCategory enum |

Unknown query fields and invalid coercions (booleans, null, arrays, fractions, blanks) are rejected. Search should match rawText without case sensitivity. Combine filters with AND; when status and category are both provided, the same workflow must match both. Sort by createdAt descending then id descending. Total counts matching requests, not workflow runs. Apply authorization scope before counting or paginating.

The response is `{ items: RequestSummary[], pagination: { page, pageSize, total } }`. Each summary contains id, createdById, createdAt and a workflows array. One request may have multiple runs; no single latest run is implied. Order embedded runs by createdAt ascending, then id ascending for a deterministic result.

Detail adds rawText. Lists omit full text; both responses omit idempotency keys. The UI preview's title/message fields are demo-only and must be mapped or replaced when integrating this contract.

## Serialization and errors

- Use UUID strings for IDs and UTC ISO-8601 strings for timestamps; convert Date objects with toISOString().
- Nullable fields are explicit null, not omitted.
- Workflow responses include version for concurrency control, plus nullable category/completedAt.
- User DTOs exclude passwordHash and password. Select fields explicitly before parsing instead of passing full Prisma records.
- Audit metadata must be redacted by server code. Validation checks JSON shape and actor identity consistency, not whether its text contains secrets.
- Serialize mock-order amounts with Decimal.toFixed(2). Decimal(12,2) values are nonnegative strings with up to 10 whole digits and exactly two decimal places. Three uppercase letters validate currency format, not ISO currency membership.
- Existing OTHER category means unsupported/unclear input and must route to manual review during workflow implementation. It does not authorize an executable fallback workflow.
- Submitted requests and audit history have no generic update/delete contracts. The disposable draft CRUD preview does not define lifecycle behavior for persisted workflows.

Error shape: `{ code, message, traceId }`. Suggested codes for future route handlers: VALIDATION_ERROR (400), UNAUTHENTICATED (401), FORBIDDEN (403), NOT_FOUND (404), IDEMPOTENCY_CONFLICT (409), INTERNAL_ERROR (500). Return redacted messages and never expose database errors, credentials or stack traces.

## Checks

```sh
pnpm --filter @flowpilot/contracts test
```

The tests build the package, check security-sensitive validation cases and compare enum values against the Prisma schema. Root `pnpm test` runs these tests followed by the existing API tests.

